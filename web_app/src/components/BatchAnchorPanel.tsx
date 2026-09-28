import {
  ArrowDownLeft,
  ArrowDownRight,
  ArrowUpLeft,
  ArrowUpRight,
} from "lucide-react"
import { useStore } from "@/lib/states"
import { cn } from "@/lib/utils"
import { BatchAnchor } from "@/lib/types"

const ANCHORS: {
  value: BatchAnchor
  label: string
  Icon: typeof ArrowUpLeft
}[] = [
  { value: "topleft", label: "Top-left", Icon: ArrowUpLeft },
  { value: "topright", label: "Top-right", Icon: ArrowUpRight },
  { value: "bottomleft", label: "Bottom-left", Icon: ArrowDownLeft },
  { value: "bottomright", label: "Bottom-right", Icon: ArrowDownRight },
]

/**
 * 批量处理区域锚点设置面板：
 * 决定矩形区域相对图片的哪个角定位（不同尺寸图片不做比例缩放）。
 */
const BatchAnchorPanel = () => {
  const [anchor, setBatchAnchor, isBatch, isProcessing] = useStore((state) => [
    state.batchState.anchor,
    state.setBatchAnchor,
    state.isBatchMode(),
    state.getIsProcessing(),
  ])

  if (!isBatch) {
    return null
  }

  return (
    <div className="z-10 fixed left-[24px] top-1/2 -translate-y-1/2 flex flex-col gap-2 border rounded-xl p-2 backdrop-filter backdrop-blur-md bg-background/80">
      <span className="text-[11px] opacity-70 px-1 whitespace-nowrap">
        Region anchor
      </span>
      <div className="grid grid-cols-2 gap-1">
        {ANCHORS.map(({ value, label, Icon }) => (
          <button
            key={value}
            type="button"
            title={label}
            disabled={isProcessing}
            onClick={() => setBatchAnchor(value)}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded border text-foreground disabled:opacity-50",
              anchor === value
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background hover:bg-accent"
            )}
          >
            <Icon className="h-4 w-4" />
          </button>
        ))}
      </div>
    </div>
  )
}

export default BatchAnchorPanel
