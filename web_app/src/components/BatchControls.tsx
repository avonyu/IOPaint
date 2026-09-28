import { useEffect, useState } from "react"
import {
  ArrowDownLeft,
  ArrowDownRight,
  ArrowUpLeft,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Layers,
} from "lucide-react"
import { Button, IconButton } from "./ui/button"
import { useStore } from "@/lib/states"
import { socket } from "@/lib/socket"
import { BatchAnchor } from "@/lib/types"

// 点击循环切换的顺序（顺时针）
const ANCHOR_ORDER: BatchAnchor[] = [
  "topleft",
  "topright",
  "bottomright",
  "bottomleft",
]

const ANCHOR_META: Record<
  BatchAnchor,
  { label: string; Icon: typeof ArrowUpLeft }
> = {
  topleft: { label: "Top-left", Icon: ArrowUpLeft },
  topright: { label: "Top-right", Icon: ArrowUpRight },
  bottomright: { label: "Bottom-right", Icon: ArrowDownRight },
  bottomleft: { label: "Bottom-left", Icon: ArrowDownLeft },
}

/**
 * 批量图片控制（集成在 Header 中）：
 * 切换浏览、应用到全部、切换区域锚点。
 * 结果下载走右侧工具栏的下载按钮。
 */
const BatchControls = () => {
  const [
    batchState,
    batchAnchor,
    isProcessing,
    switchBatchIndex,
    batchInpaintAll,
    setBatchAnchor,
  ] = useStore((state) => [
    state.batchState,
    state.batchAnchor,
    state.getIsProcessing(),
    state.switchBatchIndex,
    state.batchInpaintAll,
    state.setBatchAnchor,
  ])

  const [progress, setProgress] = useState({ current: 0, total: 0 })

  useEffect(() => {
    const onProgress = (data: { current: number; total: number }) => {
      if (data) {
        setProgress({ current: data.current, total: data.total })
      }
    }
    const onFinish = () => {
      setProgress({ current: 0, total: 0 })
    }
    socket.on("batch_progress", onProgress)
    socket.on("batch_finish", onFinish)
    return () => {
      socket.off("batch_progress", onProgress)
      socket.off("batch_finish", onFinish)
    }
  }, [])

  // 仅在导入多张图片（批量）时显示
  if (batchState.files.length <= 1) {
    return null
  }

  const {
    currentIndex,
    names,
    files,
    isProcessing: isBatchProcessing,
  } = batchState
  const busy = isBatchProcessing || isProcessing

  const anchorMeta = ANCHOR_META[batchAnchor]
  const nextAnchor =
    ANCHOR_ORDER[
      (ANCHOR_ORDER.indexOf(batchAnchor) + 1) % ANCHOR_ORDER.length
    ]

  return (
    <div className="flex items-center gap-1">
      <Layers className="w-4 h-4 opacity-70" />
      <IconButton
        tooltip="Previous image"
        disabled={busy || currentIndex === 0}
        onClick={() => switchBatchIndex(currentIndex - 1)}
      >
        <ChevronLeft />
      </IconButton>
      <div className="flex flex-col items-center leading-tight min-w-[110px]">
        <span className="text-xs font-nums">
          {currentIndex + 1} / {files.length}
        </span>
        <span className="text-[11px] opacity-70 max-w-[150px] truncate">
          {names[currentIndex]}
        </span>
      </div>
      <IconButton
        tooltip="Next image"
        disabled={busy || currentIndex >= files.length - 1}
        onClick={() => switchBatchIndex(currentIndex + 1)}
      >
        <ChevronRight />
      </IconButton>

      <Button
        size="sm"
        className="h-7"
        disabled={busy}
        onClick={() => batchInpaintAll()}
      >
        {isBatchProcessing
          ? progress.total > 0
            ? `处理中 ${progress.current}/${progress.total}`
            : "处理中..."
          : "应用到全部"}
      </Button>

      <IconButton
        tooltip={`Region anchor: ${anchorMeta.label} (click to change)`}
        disabled={busy}
        onClick={() => setBatchAnchor(nextAnchor)}
      >
        <anchorMeta.Icon />
      </IconButton>
    </div>
  )
}

export default BatchControls
