import { useEffect, useState } from "react"
import { ChevronLeft, ChevronRight, Layers, X } from "lucide-react"
import { Button, IconButton } from "./ui/button"
import { useStore } from "@/lib/states"
import { socket } from "@/lib/socket"

/**
 * 批量图片（共享 mask）控制条：切换浏览图片、应用到全部并下载 zip。
 */
const BatchBar = () => {
  const [
    batchState,
    isProcessing,
    switchBatchIndex,
    batchInpaintDownload,
    clearBatch,
  ] = useStore((state) => [
    state.batchState,
    state.getIsProcessing(),
    state.switchBatchIndex,
    state.batchInpaintDownload,
    state.clearBatch,
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

  if (batchState.files.length === 0) {
    return null
  }

  const { currentIndex, names, files, isProcessing: isBatchProcessing } =
    batchState
  const busy = isBatchProcessing || isProcessing

  return (
    <div className="z-10 fixed bottom-[88px] left-1/2 translate-x-[-50%] flex items-center gap-2 border rounded-[3rem] px-3 py-1.5 backdrop-filter backdrop-blur-md bg-background/80">
      <Layers className="w-4 h-4 opacity-70" />
      <IconButton
        tooltip="Previous image"
        disabled={busy || currentIndex === 0}
        onClick={() => switchBatchIndex(currentIndex - 1)}
      >
        <ChevronLeft />
      </IconButton>
      <div className="flex flex-col items-center leading-tight min-w-[130px]">
        <span className="text-xs font-nums">
          {currentIndex + 1} / {files.length}
        </span>
        <span className="text-[11px] opacity-70 max-w-[170px] truncate">
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
        onClick={() => batchInpaintDownload()}
      >
        {isBatchProcessing
          ? progress.total > 0
            ? `处理中 ${progress.current}/${progress.total}`
            : "处理中..."
          : "应用到全部并下载"}
      </Button>

      <IconButton tooltip="Clear batch" disabled={busy} onClick={clearBatch}>
        <X />
      </IconButton>
    </div>
  )
}

export default BatchBar
