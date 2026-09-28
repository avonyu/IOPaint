import { PlayIcon } from "@radix-ui/react-icons"
import { ChangeEvent, useEffect, useRef, useState } from "react"
import { IconButton, ImageUploadButton } from "@/components/ui/button"
import Shortcuts from "@/components/Shortcuts"
import { useImage } from "@/hooks/useImage"

import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover"
import PromptInput from "./PromptInput"
import { Image, Upload, FolderOpen, Undo, Redo } from "lucide-react"
import FileManager, { MASK_TAB } from "./FileManager"
import { getMediaBlob, getMediaFile } from "@/lib/api"
import { useStore } from "@/lib/states"
import SettingsDialog from "./Settings"
import { cn, fileToImage, isSupportedImageFile } from "@/lib/utils"
import Coffee from "./Coffee"
import BatchControls from "./BatchControls"
import { useToast } from "./ui/use-toast"

const Header = () => {
  const [
    file,
    customMask,
    isInpainting,
    serverConfig,
    runMannually,
    enableUploadMask,
    model,
    setFile,
    setCustomFile,
    runInpainting,
    imageHeight,
    imageWidth,
    handleFileManagerMaskSelect,
    setBatchFiles,
    undo,
    redo,
    undoDisabled,
    redoDisabled,
  ] = useStore((state) => [
    state.file,
    state.customMask,
    state.isInpainting,
    state.serverConfig,
    state.runMannually(),
    state.settings.enableUploadMask,
    state.settings.model,
    state.setFile,
    state.setCustomFile,
    state.runInpainting,
    state.imageHeight,
    state.imageWidth,
    state.handleFileManagerMaskSelect,
    state.setBatchFiles,
    state.undo,
    state.redo,
    state.undoDisabled(),
    state.redoDisabled(),
  ])

  const { toast } = useToast()
  const folderInputRef = useRef<HTMLInputElement>(null)

  const onFolderSelected = (ev: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(ev.currentTarget.files || [])
    const imageFiles = selected
      .filter(isSupportedImageFile)
      .sort((a, b) =>
        (a.webkitRelativePath || a.name).localeCompare(
          b.webkitRelativePath || b.name
        )
      )
    if (imageFiles.length > 0) {
      setBatchFiles(imageFiles)
    } else {
      toast({
        variant: "destructive",
        description: "No supported images found in the selected folder",
      })
    }
    ev.currentTarget.value = ""
  }

  useEffect(() => {
    // 兜底：确保文件夹选择属性一定被设置（部分环境下 JSX 属性可能不生效）
    const el = folderInputRef.current
    if (el) {
      el.setAttribute("webkitdirectory", "")
      el.setAttribute("directory", "")
    }
  }, [])

  const [maskImage, maskImageLoaded] = useImage(customMask)
  const [openMaskPopover, setOpenMaskPopover] = useState(false)


  const handleOnPhotoClick = async (tab: string, filename: string) => {
    try {
      if (tab === MASK_TAB) {
        const maskBlob = await getMediaBlob(tab, filename)
        handleFileManagerMaskSelect(maskBlob)
      } else {
        const newFile = await getMediaFile(tab, filename)
        setFile(newFile)
      }
    } catch (e: any) {
      toast({
        variant: "destructive",
        description: e.message ? e.message : e.toString(),
      })
      return
    }
  }

  return (
    <header className="h-[60px] px-6 py-4 absolute top-[0] flex justify-between items-center w-full z-20 border-b backdrop-filter backdrop-blur-md bg-background/70">
      <div className="flex items-center gap-1">
        <IconButton
          disabled={undoDisabled}
          tooltip="Undo"
          onClick={() => undo()}
        >
          <Undo />
        </IconButton>
        <IconButton
          disabled={redoDisabled}
          tooltip="Redo"
          onClick={() => redo()}
        >
          <Redo />
        </IconButton>
        {serverConfig.enableFileManager ? (
          <FileManager photoWidth={512} onPhotoClick={handleOnPhotoClick} />
        ) : (
          <></>
        )}

        <ImageUploadButton
          disabled={isInpainting}
          tooltip="Upload image"
          onFileUpload={(file) => {
            setFile(file)
          }}
        >
          <Image />
        </ImageUploadButton>

        <IconButton
          disabled={isInpainting}
          tooltip="Upload folder (batch inpainting with a shared mask)"
          onClick={() => folderInputRef.current?.click()}
        >
          <FolderOpen />
        </IconButton>
        <input
          ref={folderInputRef}
          type="file"
          accept="image/*"
          multiple
          webkitdirectory=""
          directory=""
          style={{ display: "none" }}
          onChange={onFolderSelected}
        />

        <div
          className={cn([
            "flex items-center gap-1",
            file && enableUploadMask ? "visible" : "hidden",
          ])}
        >
          <ImageUploadButton
            disabled={isInpainting}
            tooltip="Upload custom mask"
            onFileUpload={async (file) => {
              let newCustomMask: HTMLImageElement | null = null
              try {
                newCustomMask = await fileToImage(file)
              } catch (e: any) {
                toast({
                  variant: "destructive",
                  description: e.message ? e.message : e.toString(),
                })
                return
              }
              if (
                newCustomMask.naturalHeight !== imageHeight ||
                newCustomMask.naturalWidth !== imageWidth
              ) {
                toast({
                  variant: "destructive",
                  description: `The size of the mask must same as image: ${imageWidth}x${imageHeight}`,
                })
                return
              }

              setCustomFile(file)
              if (!runMannually) {
                runInpainting()
              }
            }}
          >
            <Upload />
          </ImageUploadButton>

          {customMask ? (
            <Popover open={openMaskPopover}>
              <PopoverTrigger
                className="btn-primary side-panel-trigger"
                onMouseEnter={() => setOpenMaskPopover(true)}
                onMouseLeave={() => setOpenMaskPopover(false)}
                style={{
                  visibility: customMask ? "visible" : "hidden",
                  outline: "none",
                }}
                onClick={() => {
                  if (customMask) {
                  }
                }}
              >
                <IconButton tooltip="Run custom mask">
                  <PlayIcon />
                </IconButton>
              </PopoverTrigger>
              <PopoverContent>
                {maskImageLoaded ? (
                  <img src={maskImage.src} alt="Custom mask" />
                ) : (
                  <></>
                )}
              </PopoverContent>
            </Popover>
          ) : (
            <></>
          )}
        </div>

      </div>

      <div className="flex items-center gap-3">
        <BatchControls />
        {model.need_prompt ? <PromptInput /> : <></>}
      </div>

      <div className="flex gap-1">
        <Coffee />
        <Shortcuts />
        {serverConfig.disableModelSwitch ? <></> : <SettingsDialog />}
      </div>
    </header>
  )
}

export default Header
