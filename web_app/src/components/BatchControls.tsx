import { useEffect, useState } from "react"
import { ChevronLeft, ChevronRight, Layers, X } from "lucide-react"
import { Button, IconButton } from "./ui/button"
import { useStore } from "@/lib/states"
import { socket } from "@/lib/socket"

/**
 * 批量图片控制（集成在 Header 中）：
 * 切换浏览、应用到全部、切换显示结果/原图、清空。
 * 结果下载走右侧工具栏的下载按钮。
 */
const BatchControls = () => {
  const [
    batchState,
    isProcessing,
    switchBatchIndex,
    batchInpaintAll,
    setBatchShowResult,
    clearBatch,
  ] = useStore((state) => [
    state.batchState,
    state.getIsProcessing(),
    state.switchBatchIndex,
    state.batchInpaintAll,
    state.setBatchShowResult,
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

  const {
    currentIndex,
    names,
    files,
    isProcessing: isBatchProcessing,
    results,
    showResult,
  } = batchState
  const busy = isBatchProcessing || isProcessing

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

      {results.length > 0 ? (
        <Button
          size="sm"
          variant={showResult ? "default" : "secondary"}
          className="h-7"
          onClick={() => setBatchShowResult(!showResult)}
        >
          {showResult ? "显示结果" : "显示原图"}
        </Button>
      ) : null}

      <IconButton tooltip="Clear batch" disabled={busy} onClick={clearBatch}>
        <X />
      </IconButton>
    </div>
  )
}

export default BatchControls
