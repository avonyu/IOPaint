import { persist } from "zustand/middleware"
import { shallow } from "zustand/shallow"
import { immer } from "zustand/middleware/immer"
import { castDraft } from "immer"
import { createWithEqualityFn } from "zustand/traditional"
import {
  AdjustMaskOperate,
  BatchAnchor,
  CV2Flag,
  ExtenderDirection,
  LDMSampler,
  Line,
  LineGroup,
  ModelInfo,
  PluginParams,
  Point,
  PowerPaintTask,
  Rect,
  ServerConfig,
  Size,
  SortBy,
  SortOrder,
} from "./types"
import {
  BRUSH_COLOR,
  DEFAULT_BRUSH_SIZE,
  DEFAULT_NEGATIVE_PROMPT,
  MAX_BRUSH_SIZE,
  MODEL_TYPE_INPAINT,
  PAINT_BY_EXAMPLE,
} from "./const"
import {
  blobToImage,
  canvasToImage,
  convertToBase64,
  dataURItoBlob,
  generateMask,
  getBinaryMask,
  getImageFileSize,
  loadImage,
  shiftMaskImage,
  srcToFile,
} from "./utils"
import inpaint, {
  batchDownloadZip,
  batchInpaint,
  getGenInfo,
  postAdjustMask,
  runPlugin,
} from "./api"
import { toast } from "@/components/ui/use-toast"

type FileManagerState = {
  sortBy: SortBy
  sortOrder: SortOrder
  layout: "rows" | "masonry"
  searchText: string
  inputDirectory: string
  outputDirectory: string
}

type CropperState = {
  x: number
  y: number
  width: number
  height: number
}

export type Settings = {
  model: ModelInfo
  enableDownloadMask: boolean
  enableManualInpainting: boolean
  enableUploadMask: boolean
  enableAutoExtractPrompt: boolean
  showCropper: boolean
  showExtender: boolean
  extenderDirection: ExtenderDirection

  // For LDM
  ldmSteps: number
  ldmSampler: LDMSampler

  // For ZITS
  zitsWireframe: boolean

  // For OpenCV2
  cv2Radius: number
  cv2Flag: CV2Flag

  // For Diffusion moel
  prompt: string
  negativePrompt: string
  seed: number
  seedFixed: boolean

  // For SD
  sdMaskBlur: number
  sdStrength: number
  sdSteps: number
  sdGuidanceScale: number
  sdSampler: string
  sdMatchHistograms: boolean
  sdScale: number

  // Pix2Pix
  p2pImageGuidanceScale: number

  // ControlNet
  enableControlnet: boolean
  controlnetConditioningScale: number
  controlnetMethod: string

  // BrushNet
  enableBrushNet: boolean
  brushnetMethod: string
  brushnetConditioningScale: number

  enableLCMLora: boolean

  // PowerPaint
  enablePowerPaintV2: boolean
  powerpaintTask: PowerPaintTask

  // AdjustMask
  adjustMaskKernelSize: number
}

type InteractiveSegState = {
  isInteractiveSeg: boolean
  tmpInteractiveSegMask: HTMLImageElement | null
  clicks: number[][]
  // 0 = negative point (force background), 1 = positive point (force
  // foreground). Persists across clicks so the user can keep painting the
  // same kind without toggling. Right-click in the editor still flips to
  // negative for power users.
  nextClickLabel: 0 | 1
  // Monotonic counter — bumped whenever the click set changes in a way the
  // Editor component needs to react to (e.g. a click was removed). The
  // Editor watches it and re-runs SAM2 so the preview stays in sync.
  revisionToken: number
  // Radius (px) the SAM2 mask is dilated outward by before it is rendered and
  // sent to inpainting. The inpainter needs the mask to overlap the subject:
  // a mask that ends exactly on the object's edge leaves a halo in the
  // result, because the model has no foreground pixels to infer the true
  // boundary from. 0 = exact silhouette.
  segGrowRadius: number
}

type BatchResult = {
  name: string
  url: string
}

type BatchState = {
  files: File[]
  names: string[]
  currentIndex: number
  isProcessing: boolean
  processedCount: number
  totalCount: number
  // 批量处理结果（与服务端缓存对应，用于预览与打包下载）
  // 按源图片索引对齐，跳过/失败的图片为 null
  batchId: string | null
  results: (BatchResult | null)[]
  showResult: boolean
}

type EditorState = {
  baseBrushSize: number
  brushSizeScale: number
  renders: HTMLImageElement[]
  lineGroups: LineGroup[]
  lastLineGroup: LineGroup
  curLineGroup: LineGroup

  // mask from interactive-seg or other segmentation models
  extraMasks: HTMLImageElement[]
  prevExtraMasks: HTMLImageElement[]

  temporaryMasks: HTMLImageElement[]
  // redo 相关
  redoRenders: HTMLImageElement[]
  redoCurLines: Line[]
  redoLineGroups: LineGroup[]
}

type AppState = {
  file: File | null
  paintByExampleFile: File | null
  customMask: File | null
  imageHeight: number
  imageWidth: number
  isInpainting: boolean
  isPluginRunning: boolean
  isAdjustingMask: boolean
  windowSize: Size
  editorState: EditorState
  disableShortCuts: boolean

  interactiveSegState: InteractiveSegState
  fileManagerState: FileManagerState
  batchState: BatchState

  // 批量处理时矩形区域相对图片的锚点（记住用户上次的选择，持久化保存）
  batchAnchor: BatchAnchor

  cropperState: CropperState
  extenderState: CropperState
  isCropperExtenderResizing: boolean

  // 矩形重绘区域模式
  rectMaskMode: boolean
  curRectMask: Rect | null

  serverConfig: ServerConfig

  settings: Settings
}

type AppAction = {
  updateAppState: (newState: Partial<AppState>) => void
  setFile: (file: File) => Promise<void>
  setCustomFile: (file: File) => void
  setIsInpainting: (newValue: boolean) => void
  getIsProcessing: () => boolean
  setBaseBrushSize: (newValue: number) => void
  decreaseBaseBrushSize: () => void
  increaseBaseBrushSize: () => void
  getBrushSize: () => number
  setImageSize: (width: number, height: number) => void

  isSD: () => boolean

  setCropperX: (newValue: number) => void
  setCropperY: (newValue: number) => void
  setCropperWidth: (newValue: number) => void
  setCropperHeight: (newValue: number) => void

  setExtenderX: (newValue: number) => void
  setExtenderY: (newValue: number) => void
  setExtenderWidth: (newValue: number) => void
  setExtenderHeight: (newValue: number) => void

  setIsCropperExtenderResizing: (newValue: boolean) => void
  updateExtenderDirection: (newValue: ExtenderDirection) => void
  resetExtender: (width: number, height: number) => void
  updateExtenderByBuiltIn: (direction: ExtenderDirection, scale: number) => void

  setServerConfig: (newValue: ServerConfig) => void
  setSeed: (newValue: number) => void
  updateSettings: (newSettings: Partial<Settings>) => void

  // 互斥
  updateEnablePowerPaintV2: (newValue: boolean) => void
  updateEnableBrushNet: (newValue: boolean) => void
  updateEnableControlnet: (newValue: boolean) => void
  updateLCMLora: (newValue: boolean) => void

  setModel: (newModel: ModelInfo) => void
  updateFileManagerState: (newState: Partial<FileManagerState>) => void
  updateInteractiveSegState: (newState: Partial<InteractiveSegState>) => void
  resetInteractiveSegState: () => void
  handleInteractiveSegAccept: () => void
  removeClickAt: (index: number) => void
  handleFileManagerMaskSelect: (blob: Blob) => Promise<void>
  showPromptInput: () => boolean

  runInpainting: () => Promise<void>
  showPrevMask: () => Promise<void>
  hidePrevMask: () => void
  runRenderablePlugin: (
    genMask: boolean,
    pluginName: string,
    params?: PluginParams
  ) => Promise<void>

  // EditorState
  getCurrentTargetFile: () => Promise<File>
  updateEditorState: (newState: Partial<EditorState>) => void
  runMannually: () => boolean
  handleCanvasMouseDown: (point: Point) => void
  handleCanvasMouseMove: (point: Point) => void
  cleanCurLineGroup: () => void
  resetRedoState: () => void
  undo: () => void
  redo: () => void
  undoDisabled: () => boolean
  redoDisabled: () => boolean

  // 矩形重绘区域
  setRectMaskMode: (value: boolean) => void
  setCurRectMask: (rect: Rect | null) => void
  addRectToCurLineGroup: (rect: Rect) => void
  commitPendingRect: () => void

  // 批量图片（共享 mask）
  isBatchMode: () => boolean
  setBatchFiles: (files: File[]) => Promise<void>
  switchBatchIndex: (index: number) => Promise<void>
  clearBatch: () => void
  setBatchAnchor: (anchor: BatchAnchor) => void
  translateMask: (
    dx: number,
    dy: number,
    width: number,
    height: number
  ) => Promise<void>
  batchInpaintAll: () => Promise<void>
  setBatchShowResult: (value: boolean) => Promise<void>
  applyBatchResultView: () => Promise<void>
  downloadBatchZip: () => Promise<void>

  adjustMask: (operate: AdjustMaskOperate) => Promise<void>
  clearMask: () => void
}

const defaultValues: AppState = {
  file: null,
  paintByExampleFile: null,
  customMask: null,
  imageHeight: 0,
  imageWidth: 0,
  isInpainting: false,
  isPluginRunning: false,
  isAdjustingMask: false,
  disableShortCuts: false,

  windowSize: {
    height: 600,
    width: 800,
  },
  editorState: {
    baseBrushSize: DEFAULT_BRUSH_SIZE,
    brushSizeScale: 1,
    renders: [],
    extraMasks: [],
    prevExtraMasks: [],
    temporaryMasks: [],
    lineGroups: [],
    lastLineGroup: [],
    curLineGroup: [],
    redoRenders: [],
    redoCurLines: [],
    redoLineGroups: [],
  },

  interactiveSegState: {
    isInteractiveSeg: false,
    tmpInteractiveSegMask: null,
    clicks: [],
    nextClickLabel: 1,
    revisionToken: 0,
    segGrowRadius: 9,
  },

  cropperState: {
    x: 0,
    y: 0,
    width: 512,
    height: 512,
  },
  extenderState: {
    x: 0,
    y: 0,
    width: 512,
    height: 512,
  },
  isCropperExtenderResizing: false,

  rectMaskMode: false,
  curRectMask: null,

  fileManagerState: {
    sortBy: SortBy.CTIME,
    sortOrder: SortOrder.DESCENDING,
    layout: "masonry",
    searchText: "",
    inputDirectory: "",
    outputDirectory: "",
  },

  batchState: {
    files: [],
    names: [],
    currentIndex: 0,
    isProcessing: false,
    processedCount: 0,
    totalCount: 0,
    batchId: null,
    results: [],
    showResult: false,
  },

  batchAnchor: "topleft",

  serverConfig: {
    plugins: [],
    modelInfos: [],
    removeBGModel: "briaai/RMBG-1.4",
    removeBGModels: [],
    realesrganModel: "realesr-general-x4v3",
    realesrganModels: [],
    interactiveSegModel: "vit_b",
    interactiveSegModels: [],
    enableFileManager: false,
    enableAutoSaving: false,
    enableControlnet: false,
    controlnetMethod: "lllyasviel/control_v11p_sd15_canny",
    disableModelSwitch: false,
    isDesktop: false,
    samplers: ["DPM++ 2M SDE Karras"],
  },
  settings: {
    model: {
      name: "lama",
      path: "lama",
      model_type: "inpaint",
      support_controlnet: false,
      support_brushnet: false,
      support_strength: false,
      support_outpainting: false,
      support_powerpaint_v2: false,
      controlnets: [],
      brushnets: [],
      support_lcm_lora: false,
      is_single_file_diffusers: false,
      need_prompt: false,
    },
    showCropper: false,
    showExtender: false,
    extenderDirection: ExtenderDirection.xy,
    enableDownloadMask: false,
    enableManualInpainting: false,
    enableUploadMask: false,
    enableAutoExtractPrompt: true,
    ldmSteps: 30,
    ldmSampler: LDMSampler.ddim,
    zitsWireframe: true,
    cv2Radius: 5,
    cv2Flag: CV2Flag.INPAINT_NS,
    prompt: "",
    negativePrompt: DEFAULT_NEGATIVE_PROMPT,
    seed: 42,
    seedFixed: false,
    sdMaskBlur: 12,
    sdStrength: 1.0,
    sdSteps: 50,
    sdGuidanceScale: 7.5,
    sdSampler: "DPM++ 2M",
    sdMatchHistograms: false,
    sdScale: 1.0,
    p2pImageGuidanceScale: 1.5,
    enableControlnet: false,
    controlnetMethod: "lllyasviel/control_v11p_sd15_canny",
    controlnetConditioningScale: 0.4,
    enableBrushNet: false,
    brushnetMethod: "random_mask",
    brushnetConditioningScale: 1.0,
    enableLCMLora: false,
    enablePowerPaintV2: false,
    powerpaintTask: PowerPaintTask.text_guided,
    adjustMaskKernelSize: 12,
  },
}

export const useStore = createWithEqualityFn<AppState & AppAction>()(
  persist(
    immer((set, get) => ({
      ...defaultValues,

      showPrevMask: async () => {
        if (get().settings.showExtender) {
          return
        }
        const { lastLineGroup, curLineGroup, prevExtraMasks, extraMasks } =
          get().editorState
        if (curLineGroup.length !== 0 || extraMasks.length !== 0) {
          return
        }
        const { imageWidth, imageHeight } = get()

        const maskCanvas = generateMask(
          imageWidth,
          imageHeight,
          [lastLineGroup],
          prevExtraMasks,
          BRUSH_COLOR
        )
        try {
          const maskImage = await canvasToImage(maskCanvas)
          set((state) => {
            state.editorState.temporaryMasks.push(castDraft(maskImage))
          })
        } catch (e) {
          console.error(e)
          return
        }
      },
      hidePrevMask: () => {
        set((state) => {
          state.editorState.temporaryMasks = []
        })
      },

      getCurrentTargetFile: async (): Promise<File> => {
        const file = get().file! // 一定是在 file 加载了以后才可能调用这个函数
        const renders = get().editorState.renders

        let targetFile = file
        if (renders.length > 0) {
          const lastRender = renders[renders.length - 1]
          targetFile = await srcToFile(
            lastRender.currentSrc,
            file.name,
            file.type
          )
        }
        return targetFile
      },

      runInpainting: async () => {
        const {
          isInpainting,
          file,
          paintByExampleFile,
          imageWidth,
          imageHeight,
          settings,
          cropperState,
          extenderState,
        } = get()
        if (isInpainting || file === null) {
          return
        }

        // 若存在待确认的矩形，先把它写入 mask，与笔刷笔迹一起参与本次重绘
        get().commitPendingRect()

        if (
          get().settings.model.support_outpainting &&
          settings.showExtender &&
          extenderState.x === 0 &&
          extenderState.y === 0 &&
          extenderState.height === imageHeight &&
          extenderState.width === imageWidth
        ) {
          return
        }

        const {
          lastLineGroup,
          curLineGroup,
          lineGroups,
          renders,
          prevExtraMasks,
          extraMasks,
        } = get().editorState

        const useLastLineGroup =
          curLineGroup.length === 0 &&
          extraMasks.length === 0 &&
          !settings.showExtender

        // useLastLineGroup 的影响
        // 1. 使用上一次的 mask
        // 2. 结果替换当前 render
        let maskImages: HTMLImageElement[] = []
        let maskLineGroup: LineGroup = []
        if (useLastLineGroup === true) {
          maskLineGroup = lastLineGroup
          maskImages = prevExtraMasks
        } else {
          maskLineGroup = curLineGroup
          maskImages = extraMasks
        }

        if (
          maskLineGroup.length === 0 &&
          maskImages === null &&
          !settings.showExtender
        ) {
          toast({
            variant: "destructive",
            description: "Please draw mask on picture",
          })
          return
        }

        const newLineGroups = [...lineGroups, maskLineGroup]

        set((state) => {
          state.isInpainting = true
        })

        let targetFile = file
        if (useLastLineGroup === true) {
          // renders.length == 1 还是用原来的
          if (renders.length > 1) {
            const lastRender = renders[renders.length - 2]
            targetFile = await srcToFile(
              lastRender.currentSrc,
              file.name,
              file.type
            )
          }
        } else if (renders.length > 0) {
          const lastRender = renders[renders.length - 1]
          targetFile = await srcToFile(
            lastRender.currentSrc,
            file.name,
            file.type
          )
        }

        const maskCanvas = generateMask(
          imageWidth,
          imageHeight,
          [maskLineGroup],
          maskImages,
          BRUSH_COLOR
        )
        if (useLastLineGroup) {
          const temporaryMask = await canvasToImage(maskCanvas)
          set((state) => {
            state.editorState.temporaryMasks = castDraft([temporaryMask])
          })
        }

        try {
          const res = await inpaint(
            targetFile,
            settings,
            cropperState,
            extenderState,
            dataURItoBlob(maskCanvas.toDataURL()),
            paintByExampleFile
          )

          const { blob, seed } = res
          if (seed) {
            get().setSeed(parseInt(seed, 10))
          }
          const newRender = new Image()
          await loadImage(newRender, blob)
          const newRenders = [...renders, newRender]
          get().setImageSize(newRender.width, newRender.height)
          get().updateEditorState({
            renders: newRenders,
            lineGroups: newLineGroups,
            lastLineGroup: maskLineGroup,
            curLineGroup: [],
            extraMasks: [],
            prevExtraMasks: maskImages,
          })
        } catch (e: any) {
          toast({
            variant: "destructive",
            description: e.message ? e.message : e.toString(),
          })
        }

        get().resetRedoState()
        set((state) => {
          state.isInpainting = false
          state.editorState.temporaryMasks = []
        })
      },

      runRenderablePlugin: async (
        genMask: boolean,
        pluginName: string,
        params: PluginParams = { upscale: 1 }
      ) => {
        const { renders, lineGroups } = get().editorState
        set((state) => {
          state.isPluginRunning = true
        })

        try {
          const start = new Date()
          const targetFile = await get().getCurrentTargetFile()
          const res = await runPlugin(
            genMask,
            pluginName,
            targetFile,
            params.upscale
          )
          const { blob } = res

          if (!genMask) {
            const newRender = new Image()
            await loadImage(newRender, blob)
            get().setImageSize(newRender.width, newRender.height)
            const newRenders = [...renders, newRender]
            const newLineGroups = [...lineGroups, []]
            get().updateEditorState({
              renders: newRenders,
              lineGroups: newLineGroups,
            })
          } else {
            const newMask = new Image()
            await loadImage(newMask, blob)
            set((state) => {
              state.editorState.extraMasks.push(castDraft(newMask))
            })
          }
          const end = new Date()
          const time = end.getTime() - start.getTime()
          toast({
            description: `Run ${pluginName} successfully in ${time / 1000}s`,
          })
        } catch (e: any) {
          toast({
            variant: "destructive",
            description: e.message ? e.message : e.toString(),
          })
        }
        set((state) => {
          state.isPluginRunning = false
        })
      },

      // Edirot State //
      updateEditorState: (newState: Partial<EditorState>) => {
        set((state) => {
          state.editorState = castDraft({ ...state.editorState, ...newState })
        })
      },

      cleanCurLineGroup: () => {
        get().updateEditorState({ curLineGroup: [] })
      },

      handleCanvasMouseDown: (point: Point) => {
        let lineGroup: LineGroup = []
        const state = get()
        if (state.runMannually()) {
          lineGroup = [...state.editorState.curLineGroup]
        }
        lineGroup.push({ size: state.getBrushSize(), pts: [point] })
        set((state) => {
          state.editorState.curLineGroup = lineGroup
        })
      },

      handleCanvasMouseMove: (point: Point) => {
        set((state) => {
          const curLineGroup = state.editorState.curLineGroup
          if (curLineGroup.length) {
            curLineGroup[curLineGroup.length - 1].pts.push(point)
          }
        })
      },

      runMannually: (): boolean => {
        const state = get()
        return (
          state.settings.enableManualInpainting ||
          state.settings.model.model_type !== MODEL_TYPE_INPAINT
        )
      },

      getIsProcessing: (): boolean => {
        return (
          get().isInpainting || get().isPluginRunning || get().isAdjustingMask
        )
      },

      isSD: (): boolean => {
        return get().settings.model.model_type !== MODEL_TYPE_INPAINT
      },

      // undo/redo

      undoDisabled: (): boolean => {
        const editorState = get().editorState
        if (editorState.renders.length > 0) {
          return false
        }
        if (get().runMannually()) {
          if (editorState.curLineGroup.length === 0) {
            return true
          }
        } else if (editorState.renders.length === 0) {
          return true
        }
        return false
      },

      undo: () => {
        if (
          get().runMannually() &&
          get().editorState.curLineGroup.length !== 0
        ) {
          // undoStroke
          set((state) => {
            const editorState = state.editorState
            if (editorState.curLineGroup.length === 0) {
              return
            }
            editorState.lastLineGroup = []
            const lastLine = editorState.curLineGroup.pop()!
            editorState.redoCurLines.push(lastLine)
          })
        } else {
          set((state) => {
            const editorState = state.editorState
            if (
              editorState.renders.length === 0 ||
              editorState.lineGroups.length === 0
            ) {
              return
            }
            const lastLineGroup = editorState.lineGroups.pop()!
            editorState.redoLineGroups.push(lastLineGroup)
            editorState.redoCurLines = []
            editorState.curLineGroup = []

            const lastRender = editorState.renders.pop()!
            editorState.redoRenders.push(lastRender)
          })
        }
      },

      redoDisabled: (): boolean => {
        const editorState = get().editorState
        if (editorState.redoRenders.length > 0) {
          return false
        }
        if (get().runMannually()) {
          if (editorState.redoCurLines.length === 0) {
            return true
          }
        } else if (editorState.redoRenders.length === 0) {
          return true
        }
        return false
      },

      redo: () => {
        if (
          get().runMannually() &&
          get().editorState.redoCurLines.length !== 0
        ) {
          set((state) => {
            const editorState = state.editorState
            if (editorState.redoCurLines.length === 0) {
              return
            }
            const line = editorState.redoCurLines.pop()!
            editorState.curLineGroup.push(line)
          })
        } else {
          set((state) => {
            const editorState = state.editorState
            if (
              editorState.redoRenders.length === 0 ||
              editorState.redoLineGroups.length === 0
            ) {
              return
            }
            const lastLineGroup = editorState.redoLineGroups.pop()!
            editorState.lineGroups.push(lastLineGroup)
            editorState.curLineGroup = []

            const lastRender = editorState.redoRenders.pop()!
            editorState.renders.push(lastRender)
          })
        }
      },

      resetRedoState: () => {
        set((state) => {
          state.editorState.redoCurLines = []
          state.editorState.redoLineGroups = []
          state.editorState.redoRenders = []
        })
      },

      //****//

      updateAppState: (newState: Partial<AppState>) => {
        set(() => newState)
      },

      getBrushSize: (): number => {
        return (
          get().editorState.baseBrushSize * get().editorState.brushSizeScale
        )
      },

      showPromptInput: (): boolean => {
        const model = get().settings.model
        return (
          model.model_type !== MODEL_TYPE_INPAINT &&
          model.name !== PAINT_BY_EXAMPLE
        )
      },

      setServerConfig: (newValue: ServerConfig) => {
        set((state) => {
          state.serverConfig = newValue
          state.settings.enableControlnet = newValue.enableControlnet
          state.settings.controlnetMethod = newValue.controlnetMethod
        })
      },

      updateSettings: (newSettings: Partial<Settings>) => {
        set((state) => {
          state.settings = {
            ...state.settings,
            ...newSettings,
          }
        })
      },

      updateEnablePowerPaintV2: (newValue: boolean) => {
        get().updateSettings({ enablePowerPaintV2: newValue })
        if (newValue) {
          get().updateSettings({
            enableBrushNet: false,
            enableControlnet: false,
            enableLCMLora: false,
          })
        }
      },

      updateEnableBrushNet: (newValue: boolean) => {
        get().updateSettings({ enableBrushNet: newValue })
        if (newValue) {
          get().updateSettings({
            enablePowerPaintV2: false,
            enableControlnet: false,
            enableLCMLora: false,
          })
        }
      },

      updateEnableControlnet(newValue) {
        get().updateSettings({ enableControlnet: newValue })
        if (newValue) {
          get().updateSettings({
            enablePowerPaintV2: false,
            enableBrushNet: false,
          })
        }
      },

      updateLCMLora(newValue) {
        get().updateSettings({ enableLCMLora: newValue })
        if (newValue) {
          get().updateSettings({
            enablePowerPaintV2: false,
            enableBrushNet: false,
          })
        }
      },

      setModel: (newModel: ModelInfo) => {
        set((state) => {
          state.settings.model = newModel

          if (
            newModel.support_controlnet &&
            !newModel.controlnets.includes(state.settings.controlnetMethod)
          ) {
            state.settings.controlnetMethod = newModel.controlnets[0]
          }
        })
      },

      updateFileManagerState: (newState: Partial<FileManagerState>) => {
        set((state) => {
          state.fileManagerState = {
            ...state.fileManagerState,
            ...newState,
          }
        })
      },

      updateInteractiveSegState: (newState: Partial<InteractiveSegState>) => {
        set((state) => {
          return {
            ...state,
            interactiveSegState: {
              ...state.interactiveSegState,
              ...newState,
            },
          }
        })
      },

      resetInteractiveSegState: () => {
        get().updateInteractiveSegState(defaultValues.interactiveSegState)
      },

      handleInteractiveSegAccept: () => {
        set((state) => {
          const preview = state.interactiveSegState.tmpInteractiveSegMask
          if (preview) {
            // Prefer the binary white-on-black mask attached at preview
            // time; fall back to the RGBA preview if for some reason it
            // wasn't built (older clients / future refactors).
            // immer wraps state in WritableDraft, but our helper reads a
            // plain symbol-keyed property on the underlying element, so
            // narrow back to HTMLImageElement before calling.
            const previewEl = preview as unknown as HTMLImageElement
            const binary = getBinaryMask(previewEl) ?? previewEl
            state.editorState.extraMasks.push(castDraft(binary))
          }
          state.interactiveSegState = castDraft({
            ...defaultValues.interactiveSegState,
          })
        })
      },

      // Remove a single click and bump a counter the Editor component
      // watches. Whenever the counter increments the Editor re-runs SAM2
      // with the trimmed click list, so the preview stays in sync.
      removeClickAt: (index: number) => {
        const state = get()
        const remaining = state.interactiveSegState.clicks.filter(
          (_, i) => i !== index
        )
        set((s) => {
          s.interactiveSegState.clicks = castDraft(remaining)
          s.interactiveSegState.revisionToken = s.interactiveSegState.revisionToken + 1
        })
      },

      handleFileManagerMaskSelect: async (blob: Blob) => {
        const newMask = new Image()

        await loadImage(newMask, URL.createObjectURL(blob))
        set((state) => {
          state.editorState.extraMasks.push(castDraft(newMask))
        })
        get().runInpainting()
      },

      setIsInpainting: (newValue: boolean) =>
        set((state) => {
          state.isInpainting = newValue
        }),

      setFile: async (file: File) => {
        if (get().settings.enableAutoExtractPrompt) {
          try {
            const res = await getGenInfo(file)
            if (res.prompt) {
              set((state) => {
                state.settings.prompt = res.prompt
              })
            }
            if (res.negative_prompt) {
              set((state) => {
                state.settings.negativePrompt = res.negative_prompt
              })
            }
          } catch (e: any) {
            toast({
              variant: "destructive",
              description: e.message ? e.message : e.toString(),
            })
          }
        }
        // 载入单张图片会退出批量模式（释放批量结果预览 URL）
        get().batchState.results.forEach((r) => r && URL.revokeObjectURL(r.url))
        set((state) => {
          state.file = file
          state.interactiveSegState = castDraft(
            defaultValues.interactiveSegState
          )
          state.editorState = castDraft(defaultValues.editorState)
          state.cropperState = defaultValues.cropperState
          state.rectMaskMode = false
          state.curRectMask = null
          state.batchState = castDraft(defaultValues.batchState)
        })
      },

      setCustomFile: (file: File) =>
        set((state) => {
          state.customMask = file
        }),

      setBaseBrushSize: (newValue: number) =>
        set((state) => {
          state.editorState.baseBrushSize = newValue
        }),

      decreaseBaseBrushSize: () => {
        const baseBrushSize = get().editorState.baseBrushSize
        let newBrushSize = baseBrushSize
        if (baseBrushSize > 10) {
          newBrushSize = baseBrushSize - 10
        }
        if (baseBrushSize <= 10 && baseBrushSize > 0) {
          newBrushSize = baseBrushSize - 3
        }
        get().setBaseBrushSize(newBrushSize)
      },

      increaseBaseBrushSize: () => {
        const baseBrushSize = get().editorState.baseBrushSize
        const newBrushSize = Math.min(baseBrushSize + 10, MAX_BRUSH_SIZE)
        get().setBaseBrushSize(newBrushSize)
      },

      setImageSize: (width: number, height: number) => {
        // 根据图片尺寸调整 brushSize 的 scale
        set((state) => {
          state.imageWidth = width
          state.imageHeight = height
          state.editorState.brushSizeScale =
            Math.max(Math.min(width, height), 512) / 512
        })
        get().resetExtender(width, height)
      },

      setCropperX: (newValue: number) =>
        set((state) => {
          state.cropperState.x = newValue
        }),

      setCropperY: (newValue: number) =>
        set((state) => {
          state.cropperState.y = newValue
        }),

      setCropperWidth: (newValue: number) =>
        set((state) => {
          state.cropperState.width = newValue
        }),

      setCropperHeight: (newValue: number) =>
        set((state) => {
          state.cropperState.height = newValue
        }),

      setExtenderX: (newValue: number) =>
        set((state) => {
          state.extenderState.x = newValue
        }),

      setExtenderY: (newValue: number) =>
        set((state) => {
          state.extenderState.y = newValue
        }),

      setExtenderWidth: (newValue: number) =>
        set((state) => {
          state.extenderState.width = newValue
        }),

      setExtenderHeight: (newValue: number) =>
        set((state) => {
          state.extenderState.height = newValue
        }),

      setIsCropperExtenderResizing: (newValue: boolean) =>
        set((state) => {
          state.isCropperExtenderResizing = newValue
        }),

      updateExtenderDirection: (newValue: ExtenderDirection) => {
        console.log(
          `updateExtenderDirection: ${JSON.stringify(get().extenderState)}`
        )
        set((state) => {
          state.settings.extenderDirection = newValue
          state.extenderState.x = 0
          state.extenderState.y = 0
          state.extenderState.width = state.imageWidth
          state.extenderState.height = state.imageHeight
        })
        get().updateExtenderByBuiltIn(newValue, 1.5)
      },

      updateExtenderByBuiltIn: (
        direction: ExtenderDirection,
        scale: number
      ) => {
        const newExtenderState = { ...defaultValues.extenderState }
        let { x, y, width, height } = newExtenderState
        const { imageWidth, imageHeight } = get()
        width = imageWidth
        height = imageHeight

        switch (direction) {
          case ExtenderDirection.x:
            x = -Math.ceil((imageWidth * (scale - 1)) / 2)
            width = Math.ceil(imageWidth * scale)
            break
          case ExtenderDirection.y:
            y = -Math.ceil((imageHeight * (scale - 1)) / 2)
            height = Math.ceil(imageHeight * scale)
            break
          case ExtenderDirection.xy:
            x = -Math.ceil((imageWidth * (scale - 1)) / 2)
            y = -Math.ceil((imageHeight * (scale - 1)) / 2)
            width = Math.ceil(imageWidth * scale)
            height = Math.ceil(imageHeight * scale)
            break
          default:
            break
        }

        set((state) => {
          state.extenderState.x = x
          state.extenderState.y = y
          state.extenderState.width = width
          state.extenderState.height = height
        })
      },

      resetExtender: (width: number, height: number) => {
        set((state) => {
          state.extenderState.x = 0
          state.extenderState.y = 0
          state.extenderState.width = width
          state.extenderState.height = height
        })
      },

      setSeed: (newValue: number) =>
        set((state) => {
          state.settings.seed = newValue
        }),

      adjustMask: async (operate: AdjustMaskOperate) => {
        const { imageWidth, imageHeight } = get()
        const { curLineGroup, extraMasks } = get().editorState
        const { adjustMaskKernelSize } = get().settings
        if (curLineGroup.length === 0 && extraMasks.length === 0) {
          return
        }

        set((state) => {
          state.isAdjustingMask = true
        })

        const maskCanvas = generateMask(
          imageWidth,
          imageHeight,
          [curLineGroup],
          extraMasks,
          BRUSH_COLOR
        )
        const maskBlob = dataURItoBlob(maskCanvas.toDataURL())
        const newMaskBlob = await postAdjustMask(
          maskBlob,
          operate,
          adjustMaskKernelSize
        )
        const newMask = await blobToImage(newMaskBlob)

        // TODO: currently ignore stroke undo/redo
        set((state) => {
          state.editorState.extraMasks = [castDraft(newMask)]
          state.editorState.curLineGroup = []
        })

        set((state) => {
          state.isAdjustingMask = false
        })
      },
      clearMask: () => {
        set((state) => {
          state.editorState.extraMasks = []
          state.editorState.curLineGroup = []
          state.curRectMask = null
        })
      },

      // 矩形重绘区域模式
      setRectMaskMode: (value: boolean) => {
        set((state) => {
          state.rectMaskMode = value
          if (!value) {
            state.curRectMask = null
          }
        })
      },

      setCurRectMask: (rect: Rect | null) => {
        set((state) => {
          state.curRectMask = rect
        })
      },

      addRectToCurLineGroup: (rect: Rect) => {
        const rectLine = {
          isRect: true,
          pts: [
            { x: rect.x, y: rect.y },
            { x: rect.x + rect.width, y: rect.y + rect.height },
          ],
        }
        set((state) => {
          state.editorState.curLineGroup.push(castDraft(rectLine))
        })
      },

      commitPendingRect: () => {
        const rect = get().curRectMask
        if (!rect) {
          return
        }
        set((state) => {
          state.curRectMask = null
        })
        if (rect.width < 4 || rect.height < 4) {
          return
        }
        // 允许矩形超出图片范围，直接写入 mask（超出部分在生成 mask 时会被画布裁剪）
        get().addRectToCurLineGroup({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        })
      },

      // 批量图片（共享 mask）
      isBatchMode: (): boolean => {
        // 仅多张图片才算批量模式
        return get().batchState.files.length > 1
      },

      setBatchFiles: async (files: File[]) => {
        if (files.length === 0) {
          return
        }
        // 先按普通方式载入第一张（会重置编辑器与批量状态）
        await get().setFile(files[0])
        set((state) => {
          state.batchState.files = castDraft(files)
          state.batchState.names = files.map((f) => f.name)
          state.batchState.currentIndex = 0
          state.batchState.processedCount = 0
          state.batchState.totalCount = files.length
          state.batchState.batchId = null
          state.batchState.results = []
          state.batchState.showResult = false
        })
      },

      clearBatch: () => {
        get().batchState.results.forEach((r) => r && URL.revokeObjectURL(r.url))
        set((state) => {
          state.batchState = castDraft(defaultValues.batchState)
        })
      },

      switchBatchIndex: async (index: number) => {
        const { batchState } = get()
        if (index < 0 || index >= batchState.files.length) {
          return
        }
        if (index === batchState.currentIndex) {
          return
        }
        const fromWidth = get().imageWidth
        const fromHeight = get().imageHeight
        const targetFile = batchState.files[index]

        let toWidth = fromWidth
        let toHeight = fromHeight
        try {
          const targetSize = await getImageFileSize(targetFile)
          toWidth = targetSize[0]
          toHeight = targetSize[1]
        } catch (e) {
          console.error(e)
        }

        // 按锚点把共享 mask 平移到目标图片（只平移、不按比例缩放）
        if (fromWidth > 0 && fromHeight > 0 && toWidth > 0 && toHeight > 0) {
          const anchor = get().batchAnchor
          const dx =
            anchor === "topright" || anchor === "bottomright"
              ? toWidth - fromWidth
              : 0
          const dy =
            anchor === "bottomleft" || anchor === "bottomright"
              ? toHeight - fromHeight
              : 0
          if (dx !== 0 || dy !== 0) {
            await get().translateMask(dx, dy, toWidth, toHeight)
          }
        }

        set((state) => {
          state.file = targetFile
          state.batchState.currentIndex = index
          // 保留共享 mask（curLineGroup/extraMasks），清空当前图片的重绘历史
          state.editorState.renders = []
          state.editorState.lineGroups = []
          state.editorState.lastLineGroup = []
          state.editorState.redoRenders = []
          state.editorState.redoCurLines = []
          state.editorState.redoLineGroups = []
          state.editorState.temporaryMasks = []
          state.cropperState = defaultValues.cropperState
          state.interactiveSegState = castDraft(
            defaultValues.interactiveSegState
          )
        })

        if (toWidth > 0 && toHeight > 0) {
          get().setImageSize(toWidth, toHeight)
        }
        // 切换图片后按当前视图显示原图/结果
        await get().applyBatchResultView()
      },

      setBatchAnchor: (anchor: BatchAnchor) => {
        set((state) => {
          state.batchAnchor = anchor
        })
      },

      translateMask: async (
        dx: number,
        dy: number,
        width: number,
        height: number
      ) => {
        if (width <= 0 || height <= 0 || (dx === 0 && dy === 0)) {
          return
        }
        const shiftPoint = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy })
        const shiftLine = (line: Line): Line => ({
          ...line,
          pts: line.pts.map(shiftPoint),
        })
        const shiftGroup = (group: LineGroup): LineGroup =>
          group.map(shiftLine)

        const {
          curLineGroup,
          lastLineGroup,
          lineGroups,
          extraMasks,
          prevExtraMasks,
          temporaryMasks,
        } = get().editorState
        const curRectMask = get().curRectMask

        const [shiftedExtra, shiftedPrev, shiftedTemp] = await Promise.all([
          Promise.all(
            extraMasks.map((m) => shiftMaskImage(m, dx, dy, width, height))
          ),
          Promise.all(
            prevExtraMasks.map((m) => shiftMaskImage(m, dx, dy, width, height))
          ),
          Promise.all(
            temporaryMasks.map((m) => shiftMaskImage(m, dx, dy, width, height))
          ),
        ])

        set((state) => {
          state.editorState.curLineGroup = castDraft(shiftGroup(curLineGroup))
          state.editorState.lastLineGroup = castDraft(
            shiftGroup(lastLineGroup)
          )
          state.editorState.lineGroups = castDraft(lineGroups.map(shiftGroup))
          state.editorState.extraMasks = castDraft(shiftedExtra)
          state.editorState.prevExtraMasks = castDraft(shiftedPrev)
          state.editorState.temporaryMasks = castDraft(shiftedTemp)
          state.curRectMask = curRectMask
            ? {
                x: curRectMask.x + dx,
                y: curRectMask.y + dy,
                width: curRectMask.width,
                height: curRectMask.height,
              }
            : null
        })
      },

      batchInpaintAll: async () => {
        const {
          batchState,
          imageWidth,
          imageHeight,
          settings,
          cropperState,
          extenderState,
        } = get()
        if (batchState.files.length === 0) {
          return
        }
        // 待确认的矩形先写入共享 mask，随“应用到全部”一起处理
        get().commitPendingRect()
        const { curLineGroup, extraMasks } = get().editorState
        if (
          curLineGroup.length === 0 &&
          extraMasks.length === 0 &&
          !settings.showExtender
        ) {
          toast({
            variant: "destructive",
            description: "Please draw mask on picture",
          })
          return
        }

        // 释放上一次结果的预览 URL
        get().batchState.results.forEach((r) => r && URL.revokeObjectURL(r.url))

        set((state) => {
          state.batchState.isProcessing = true
          state.batchState.processedCount = 0
          state.batchState.totalCount = state.batchState.files.length
          state.batchState.results = []
          state.batchState.batchId = null
          state.batchState.showResult = false
        })

        try {
          const maskCanvas = generateMask(
            imageWidth,
            imageHeight,
            [curLineGroup],
            extraMasks,
            BRUSH_COLOR
          )
          const maskBase64 = maskCanvas.toDataURL()

          const imagesBase64 = await Promise.all(
            batchState.files.map((f) => convertToBase64(f))
          )

          const { batchId, results } = await batchInpaint(
            imagesBase64,
            batchState.names,
            maskBase64,
            imageWidth,
            imageHeight,
            get().batchAnchor,
            settings,
            cropperState,
            extenderState
          )

          // 按源图片索引对齐结果
          const aligned: (BatchResult | null)[] = new Array(
            batchState.files.length
          ).fill(null)
          results.forEach((r, i) => {
            // 兼容旧后端：没有 index 字段时按顺序回退
            const idx = typeof r.index === "number" ? r.index : i
            if (idx >= 0 && idx < aligned.length) {
              aligned[idx] = {
                name: r.name,
                url: URL.createObjectURL(dataURItoBlob(r.image)),
              }
            }
          })
          const okCount = aligned.filter(Boolean).length

          set((state) => {
            state.batchState.batchId = batchId
            state.batchState.results = castDraft(aligned)
            // 处理完成后默认显示结果
            state.batchState.showResult = okCount > 0
            state.batchState.isProcessing = false
          })

          // 把当前图片的结果同步到渲染通道，否则结果视图下仍显示原图
          await get().applyBatchResultView()

          toast({
            description: `Batch inpainting finished (${okCount} images)`,
          })
        } catch (e: any) {
          toast({
            variant: "destructive",
            description: e.message ? e.message : e.toString(),
          })
          set((state) => {
            state.batchState.isProcessing = false
          })
        }
      },

      setBatchShowResult: async (value: boolean) => {
        set((state) => {
          state.batchState.showResult = value
        })
        await get().applyBatchResultView()
      },

      /**
       * 把当前图片的批量结果同步到 editorState.renders，
       * 复用与单图擦除完全一致的显示通道（图片画布渲染 renders）。
       */
      applyBatchResultView: async () => {
        const { showResult, results, currentIndex } = get().batchState
        const result = results[currentIndex]
        if (!showResult || !result) {
          set((state) => {
            state.editorState.renders = []
          })
          return
        }
        try {
          const img = new Image()
          await loadImage(img, result.url)
          set((state) => {
            state.editorState.renders = castDraft([img])
          })
        } catch (e) {
          console.error("Failed to load batch result image", e)
        }
      },

      downloadBatchZip: async () => {
        const { batchId } = get().batchState
        if (!batchId) {
          toast({
            variant: "destructive",
            description: "No batch results to download",
          })
          return
        }
        try {
          const blob = await batchDownloadZip(batchId)
          const url = URL.createObjectURL(blob)
          const link = document.createElement("a")
          link.href = url
          link.download = "iopaint_batch_results.zip"
          document.body.appendChild(link)
          link.click()
          link.remove()
          window.setTimeout(() => URL.revokeObjectURL(url), 1000)
        } catch (e: any) {
          toast({
            variant: "destructive",
            description: e.message ? e.message : e.toString(),
          })
        }
      },
    })),
    {
      name: "ZUSTAND_STATE", // name of the item in the storage (must be unique)
      version: 2,
      partialize: (state) =>
        Object.fromEntries(
          Object.entries(state).filter(([key]) =>
            ["fileManagerState", "settings", "batchAnchor"].includes(key)
          )
        ),
    }
  ),
  shallow
)
