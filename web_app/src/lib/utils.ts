import { type ClassValue, clsx } from "clsx"
import { SyntheticEvent } from "react"
import { twMerge } from "tailwind-merge"
import { LineGroup } from "./types"
import { BRUSH_COLOR } from "./const"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function keepGUIAlive() {
  async function getRequest(url = "") {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-cache",
    })
    return response.json()
  }

  const keepAliveServer = () => {
    const url = document.location
    const route = "/flaskwebgui-keep-server-alive"
    getRequest(url + route).then((data) => {
      return data
    })
  }

  const intervalRequest = 3 * 1000
  keepAliveServer()
  setInterval(keepAliveServer, intervalRequest)
}

export function dataURItoBlob(dataURI: string) {
  const mime = dataURI.split(",")[0].split(":")[1].split(";")[0]
  const binary = atob(dataURI.split(",")[1])
  const array = []
  for (let i = 0; i < binary.length; i += 1) {
    array.push(binary.charCodeAt(i))
  }
  return new Blob([new Uint8Array(array)], { type: mime })
}

export function loadImage(image: HTMLImageElement, src: string) {
  return new Promise((resolve, reject) => {
    const initSRC = image.src
    const img = image
    img.onload = resolve
    img.onerror = (err) => {
      img.src = initSRC
      reject(err)
    }
    img.src = src
  })
}

export async function blobToImage(blob: Blob) {
  const dataURL = URL.createObjectURL(blob)
  const newImage = new Image()
  await loadImage(newImage, dataURL)
  return newImage
}

export function canvasToImage(
  canvas: HTMLCanvasElement
): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()

    image.addEventListener("load", () => {
      resolve(image)
    })

    image.addEventListener("error", (error) => {
      reject(error)
    })

    image.src = canvas.toDataURL()
  })
}

export const SUPPORTED_IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "bmp",
  "tif",
  "tiff",
]

/**
 * 判断是否为受支持的图片。
 * 注意：通过 webkitdirectory 选择文件夹时，部分浏览器的 File.type 可能为空，
 * 因此这里同时按扩展名兜底判断。
 */
export function isSupportedImageFile(file: File): boolean {
  if (file.type && file.type.startsWith("image/")) {
    return true
  }
  const ext = file.name.split(".").pop()?.toLowerCase() ?? ""
  return SUPPORTED_IMAGE_EXTENSIONS.includes(ext)
}

interface FileSystemEntryLike {
  isFile: boolean
  isDirectory: boolean
  file: (
    onSuccess: (file: File) => void,
    onError?: (err: unknown) => void
  ) => void
  createReader: () => {
    readEntries: (
      onSuccess: (entries: FileSystemEntryLike[]) => void,
      onError?: (err: unknown) => void
    ) => void
  }
}

function readFileSystemEntry(entry: FileSystemEntryLike): Promise<File[]> {
  if (entry.isFile) {
    return new Promise((resolve) => {
      entry.file(
        (file) => resolve([file]),
        () => resolve([])
      )
    })
  }
  if (entry.isDirectory) {
    const reader = entry.createReader()
    return new Promise((resolve) => {
      const all: FileSystemEntryLike[] = []
      const readBatch = () => {
        reader.readEntries(
          (results) => {
            if (results.length === 0) {
              Promise.all(all.map(readFileSystemEntry))
                .then((nested) => resolve(nested.flat()))
                .catch(() => resolve([]))
            } else {
              all.push(...results)
              readBatch()
            }
          },
          () => resolve([])
        )
      }
      readBatch()
    })
  }
  return Promise.resolve([])
}

/**
 * 从拖拽事件中解析文件列表，支持拖入整个文件夹（递归）。
 */
export async function filesFromDataTransfer(
  dataTransfer: DataTransfer
): Promise<File[]> {
  const items = Array.from(dataTransfer.items || [])
  const entries: (FileSystemEntryLike | null)[] = items
    .filter((item) => item.kind === "file")
    .map((item) => {
      const getEntry = (
        item as unknown as {
          webkitGetAsEntry?: () => FileSystemEntryLike | null
        }
      ).webkitGetAsEntry
      return typeof getEntry === "function" ? getEntry.call(item) : null
    })

  if (entries.some((entry) => entry)) {
    const results = await Promise.all(
      entries.map((entry) =>
        entry ? readFileSystemEntry(entry) : Promise.resolve([])
      )
    )
    return results.flat()
  }

  return Array.from(dataTransfer.files || [])
}

export function getImageFileSize(file: File): Promise<[number, number]> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      resolve([img.naturalWidth, img.naturalHeight])
      URL.revokeObjectURL(url)
    }
    img.onerror = (err) => {
      URL.revokeObjectURL(url)
      reject(err)
    }
    img.src = url
  })
}

/**
 * 将 mask 图片按目标尺寸重新绘制（最近邻，保持二值边缘），
 * 用于批量处理时把共享 mask 适配到不同尺寸的图片。
 */
export function scaleMaskImage(
  source: HTMLImageElement,
  width: number,
  height: number
): Promise<HTMLImageElement> {
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) {
    return Promise.reject(new Error("could not retrieve mask canvas"))
  }
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(source, 0, 0, width, height)
  return canvasToImage(canvas)
}

export function fileToImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const image = new Image()
      image.onload = () => {
        resolve(image)
      }
      image.onerror = () => {
        reject("无法加载图像。")
      }
      image.src = reader.result as string
    }
    reader.onerror = () => {
      reject("无法读取文件。")
    }
    reader.readAsDataURL(file)
  })
}

export function srcToFile(src: string, fileName: string, mimeType: string) {
  return fetch(src)
    .then(function (res) {
      return res.arrayBuffer()
    })
    .then(function (buf) {
      return new File([buf], fileName, { type: mimeType })
    })
}

export async function askWritePermission() {
  try {
    // The clipboard-write permission is granted automatically to pages
    // when they are the active tab. So it's not required, but it's more safe.
    const { state } = await navigator.permissions.query({
      name: "clipboard-write" as PermissionName,
    })
    return state === "granted"
  } catch (error) {
    // Browser compatibility / Security error (ONLY HTTPS) ...
    return false
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string): Promise<any> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(async (d) => {
      if (d) {
        resolve(d)
      } else {
        reject(new Error("Expected toBlob() to be defined"))
      }
    }, mime)
  )
}

const setToClipboard = async (blob: any) => {
  const data = [new ClipboardItem({ [blob.type]: blob })]
  await navigator.clipboard.write(data)
}

export function isRightClick(ev: SyntheticEvent) {
  const mouseEvent = ev.nativeEvent as MouseEvent
  return mouseEvent.button === 2
}

export function isMidClick(ev: SyntheticEvent) {
  const mouseEvent = ev.nativeEvent as MouseEvent
  return mouseEvent.button === 1
}

export async function copyCanvasImage(canvas: HTMLCanvasElement) {
  const blob = await canvasToBlob(canvas, "image/png")
  try {
    await setToClipboard(blob)
  } catch {
    console.log("Copy image failed!")
  }
}

export function downloadImage(uri: string, name: string) {
  const link = document.createElement("a")
  link.href = uri
  link.download = name

  // this is necessary as link.click() does not work on the latest firefox
  link.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: window,
    })
  )

  setTimeout(() => {
    // For Firefox it is necessary to delay revoking the ObjectURL
    // window.URL.revokeObjectURL(base64)
    link.remove()
  }, 100)
}

export function mouseXY(ev: SyntheticEvent) {
    const mouseEvent = ev.nativeEvent as MouseEvent
    // Handle mask drawing coordinate on mobile/tablet devices
    if ('touches' in ev) {
        const rect = (ev.target as HTMLCanvasElement).getBoundingClientRect();
        const touches = ev.touches as (Touch & { target: HTMLCanvasElement })[]
        const touch = touches[0]
        return {
            x: (touch.clientX - rect.x) / rect.width * touch.target.offsetWidth,
            y: (touch.clientY - rect.y) / rect.height * touch.target.offsetHeight,
        }
    }
    return {x: mouseEvent.offsetX, y: mouseEvent.offsetY}
}

export function drawLines(
  ctx: CanvasRenderingContext2D,
  lines: LineGroup,
  color = BRUSH_COLOR
) {
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineCap = "round"
  ctx.lineJoin = "round"

  lines.forEach((line) => {
    if (!line?.pts.length) {
      return
    }
    // 矩形 line：以填充方式绘制整个矩形区域
    if (line.isRect && line.pts.length >= 2) {
      const topLeft = line.pts[0]
      const bottomRight = line.pts[1]
      const x = Math.min(topLeft.x, bottomRight.x)
      const y = Math.min(topLeft.y, bottomRight.y)
      const width = Math.abs(bottomRight.x - topLeft.x)
      const height = Math.abs(bottomRight.y - topLeft.y)
      ctx.fillRect(x, y, width, height)
      return
    }
    if (!line.size) {
      return
    }
    // 单点笔迹（单击不移动画笔）：显式绘制实心圆点。
    // 不再依赖零长度路径 + round line cap 的渲染（部分环境不会绘制零长度路径），
    // 保证单击也能生成有效的 mask。
    if (line.pts.length === 1) {
      const pt = line.pts[0]
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, line.size / 2, 0, Math.PI * 2)
      ctx.fill()
      return
    }
    ctx.lineWidth = line.size
    ctx.beginPath()
    ctx.moveTo(line.pts[0].x, line.pts[0].y)
    line.pts.forEach((pt) => ctx.lineTo(pt.x, pt.y))
    ctx.stroke()
  })
}



export const generateMask = (
  imageWidth: number,
  imageHeight: number,
  lineGroups: LineGroup[],
  maskImages: HTMLImageElement[] = [],
  lineGroupsColor: string = "white"
): HTMLCanvasElement => {
  const maskCanvas = document.createElement("canvas")
  maskCanvas.width = imageWidth
  maskCanvas.height = imageHeight
  const ctx = maskCanvas.getContext("2d")
  if (!ctx) {
    throw new Error("could not retrieve mask canvas")
  }

  maskImages.forEach((maskImage) => {
    ctx.drawImage(maskImage, 0, 0, imageWidth, imageHeight)
  })

  lineGroups.forEach((lineGroup) => {
    drawLines(ctx, lineGroup, lineGroupsColor)
  })

  return maskCanvas
}

export const convertToBase64 = (fileOrBlob: File | Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (event) => {
      const base64String = event.target?.result as string
      resolve(base64String)
    }
    reader.onerror = (error) => {
      reject(error)
    }
    reader.readAsDataURL(fileOrBlob)
  })
}
