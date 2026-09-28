import {
  PointerEvent as ReactPointerEvent,
  useEffect,
  useState,
} from "react"
import { useStore } from "@/lib/states"
import { cn } from "@/lib/utils"

const DOC_MOVE_OPTS = { capture: true, passive: false }
const HANDLE_SIZE = 12
const MIN_SIZE = 8

interface EVData {
  initX: number
  initY: number
  initWidth: number
  initHeight: number
  startX: number
  startY: number
  ord: string
}

interface EditorProps {
  scale: number
  /** 正在拖拽绘制中：仅显示虚线框，不响应移动/缩放 */
  drawing: boolean
}

export const RectMaskEditor = (props: EditorProps) => {
  const { scale, drawing } = props
  const [rect, setRect] = useStore((state) => [
    state.curRectMask,
    state.setCurRectMask,
  ])

  const [isMoving, setIsMoving] = useState(false)
  const [isResizing, setIsResizing] = useState(false)
  const [evData, setEVData] = useState<EVData>({
    initX: 0,
    initY: 0,
    initWidth: 0,
    initHeight: 0,
    startX: 0,
    startY: 0,
    ord: "",
  })

  // 允许矩形超出图片范围：这里只保证最小尺寸
  const clampRect = (x: number, y: number, w: number, h: number) => ({
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(Math.max(MIN_SIZE, w)),
    height: Math.round(Math.max(MIN_SIZE, h)),
  })

  const onPointerMove = (e: PointerEvent) => {
    if (!rect) {
      return
    }
    const dx = (e.clientX - evData.startX) / scale
    const dy = (e.clientY - evData.startY) / scale
    let x = evData.initX
    let y = evData.initY
    let w = evData.initWidth
    let h = evData.initHeight

    if (isMoving) {
      x = evData.initX + dx
      y = evData.initY + dy
    } else if (isResizing) {
      const ord = evData.ord
      if (ord.includes("left")) {
        x = evData.initX + dx
        w = evData.initWidth - dx
      }
      if (ord.includes("right")) {
        w = evData.initWidth + dx
      }
      if (ord.includes("top")) {
        y = evData.initY + dy
        h = evData.initHeight - dy
      }
      if (ord.includes("bottom")) {
        h = evData.initHeight + dy
      }
    }
    setRect(clampRect(x, y, w, h))
  }

  useEffect(() => {
    if (!isMoving && !isResizing) {
      return
    }
    const onDone = () => {
      setIsMoving(false)
      setIsResizing(false)
    }
    document.addEventListener("pointermove", onPointerMove, DOC_MOVE_OPTS)
    document.addEventListener("pointerup", onDone, DOC_MOVE_OPTS)
    document.addEventListener("pointercancel", onDone, DOC_MOVE_OPTS)
    return () => {
      document.removeEventListener("pointermove", onPointerMove, DOC_MOVE_OPTS)
      document.removeEventListener("pointerup", onDone, DOC_MOVE_OPTS)
      document.removeEventListener("pointercancel", onDone, DOC_MOVE_OPTS)
    }
  }, [isMoving, isResizing, evData, rect])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drawing || !rect) {
      return
    }
    e.stopPropagation()
    e.preventDefault()
    const ord = (e.target as HTMLElement).dataset.ord ?? ""
    setEVData({
      initX: rect.x,
      initY: rect.y,
      initWidth: rect.width,
      initHeight: rect.height,
      startX: e.clientX,
      startY: e.clientY,
      ord,
    })
    if (ord) {
      setIsResizing(true)
    } else {
      setIsMoving(true)
    }
  }

  const createHandle = (cursor: string, side1: string, side2: string) => {
    const half = HANDLE_SIZE / 2
    let xTrans = "0"
    let yTrans = "0"
    let side2Key = side2
    let side2Val = `${-half}px`
    if (side2 === "") {
      side2Val = "50%"
      if (side1 === "left" || side1 === "right") {
        side2Key = "top"
        yTrans = "-50%"
      } else {
        side2Key = "left"
        xTrans = "-50%"
      }
    }
    return (
      <div
        key={side1 + side2}
        // 仅作为边框上的缩放热区，不显示锚点方块（靠光标变化提示可缩放）
        className={cn("absolute z-[4] pointer-events-auto", cursor)}
        style={{
          width: HANDLE_SIZE,
          height: HANDLE_SIZE,
          [side1]: -half,
          [side2Key]: side2Val,
          transform: `translate(${xTrans}, ${yTrans}) scale(${1 / scale})`,
        }}
        data-ord={side1 + side2}
      />
    )
  }

  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return null
  }

  return (
    <div className="absolute h-full w-full pointer-events-none z-[3]">
      <div
        className={cn(
          "absolute",
          drawing ? "pointer-events-none" : "pointer-events-auto cursor-move"
        )}
        style={{
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
        }}
        onPointerDown={onPointerDown}
      >
        <div className="absolute inset-0 border-2 border-dashed border-primary bg-primary/10 pointer-events-none" />
        {!drawing && (
          <>
            {createHandle("cursor-nw-resize", "top", "left")}
            {createHandle("cursor-ne-resize", "top", "right")}
            {createHandle("cursor-sw-resize", "bottom", "left")}
            {createHandle("cursor-se-resize", "bottom", "right")}
            {createHandle("cursor-ns-resize", "top", "")}
            {createHandle("cursor-ns-resize", "bottom", "")}
            {createHandle("cursor-ew-resize", "left", "")}
            {createHandle("cursor-ew-resize", "right", "")}
          </>
        )}
      </div>
    </div>
  )
}


