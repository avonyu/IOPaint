import { useStore } from "@/lib/states"
import { Button } from "./ui/button"
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog"
import { Minus, Plus } from "lucide-react"

interface InteractiveSegReplaceModal {
  show: boolean
  onClose: () => void
  onCleanClick: () => void
  onReplaceClick: () => void
}

const InteractiveSegReplaceModal = (props: InteractiveSegReplaceModal) => {
  const { show, onClose, onCleanClick, onReplaceClick } = props

  const onOpenChange = (open: boolean) => {
    if (!open) {
      onClose()
    }
  }

  return (
    <Dialog open={show} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Do you want to remove it or create a new one?</DialogTitle>
        <div className="flex gap-[12px] w-full justify-end items-center">
          <Button
            onClick={() => {
              onClose()
              onCleanClick()
            }}
          >
            Remove
          </Button>
          <Button onClick={onReplaceClick}>Create new</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

const InteractiveSegConfirmActions = () => {
  const [
    interactiveSegState,
    updateInteractiveSegState,
    resetInteractiveSegState,
    handleInteractiveSegAccept,
  ] = useStore((state) => [
    state.interactiveSegState,
    state.updateInteractiveSegState,
    state.resetInteractiveSegState,
    state.handleInteractiveSegAccept,
  ])

  if (!interactiveSegState.isInteractiveSeg) {
    return null
  }

  const setLabel = (label: 0 | 1) => {
    updateInteractiveSegState({ nextClickLabel: label })
  }
  const isPositive = interactiveSegState.nextClickLabel === 1

  const setGrowRadius = (radius: number) => {
    updateInteractiveSegState({ segGrowRadius: radius })
    // Re-run SAM2 right away so the slider behaves as a live preview.
    // The Editor mounts this hook as a window-side binding so the toolbar
    // can trigger a refresh without faking a click on the canvas.
    const runInteractiveSeg = window.__iopaintRunInteractiveSeg
    if (runInteractiveSeg && interactiveSegState.clicks.length > 0) {
      void runInteractiveSeg(interactiveSegState.clicks)
    }
  }

  return (
    <div className="z-10 absolute top-[68px] rounded-xl border-solid border p-[8px] left-1/2 translate-x-[-50%] flex flex-col gap-2 bg-background">
      <div className="flex justify-center items-center gap-[8px]">
        {/* Click-mode toggle. Positive (green) is the default — clicking adds
            foreground. Negative (red) lets the user mark "exclude this area",
            which is the standard SAM trick to patch up holes / holes where
            SAM2 missed the foreground. Right-click always counts as
            negative regardless of this toggle. */}
        <div
          className="flex overflow-hidden rounded-md border border-input"
          title="Pick the kind of click to add on the image"
        >
          <button
            type="button"
            aria-label="Add positive (foreground) points"
            aria-pressed={isPositive}
            onClick={() => setLabel(1)}
            className={
              "flex h-8 w-8 items-center justify-center transition " +
              (isPositive
                ? "bg-[rgba(21,215,121,0.95)] text-white"
                : "bg-transparent text-muted-foreground hover:bg-accent")
            }
          >
            <Plus className="h-4 w-4" strokeWidth={3} />
          </button>
          <button
            type="button"
            aria-label="Add negative (background) points"
            aria-pressed={!isPositive}
            onClick={() => setLabel(0)}
            className={
              "flex h-8 w-8 items-center justify-center border-l border-input transition " +
              (!isPositive
                ? "bg-[rgba(237,49,55,0.95)] text-white"
                : "bg-transparent text-muted-foreground hover:bg-accent")
            }
          >
            <Minus className="h-4 w-4" strokeWidth={3} />
          </button>
        </div>
        <Button
          onClick={() => {
            resetInteractiveSegState()
          }}
          size="sm"
          variant="secondary"
        >
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => {
            handleInteractiveSegAccept()
          }}
        >
          Accept
        </Button>
      </div>
      {/* Grow-radius slider. The inpainter needs the mask to overlap the
          subject: a mask ending exactly on the object's edge leaves a halo,
          so we dilate outward by a few pixels by default. */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <label htmlFor="iopaint-seg-grow-radius" className="whitespace-nowrap">
          Grow:
        </label>
        <input
          id="iopaint-seg-grow-radius"
          type="range"
          min={0}
          max={48}
          step={1}
          value={interactiveSegState.segGrowRadius}
          onChange={(e) => setGrowRadius(Number(e.target.value))}
          className="flex-1 accent-primary"
        />
        <span className="w-8 text-right tabular-nums">
          {interactiveSegState.segGrowRadius}px
        </span>
      </div>
    </div>
  )
}

interface ItemProps {
  x: number
  y: number
  positive: boolean
  // Index in clicks[]. Used to splice the click out when the user clicks
  // the dot to remove it.
  index: number
}

const Item = (props: ItemProps) => {
  const { x, y, positive, index } = props
  const name = positive
    ? "bg-[rgba(21,_215,_121,_0.936)] outline-[rgba(98,255,179,0.31)]"
    : "bg-[rgba(237,_49,_55,_0.942)] outline-[rgba(255,89,95,0.31)]"

  const removeClickAt = useStore((state) => state.removeClickAt)
  return (
    <button
      type="button"
      aria-label={positive ? "Remove positive click" : "Remove negative click"}
      title="Click to remove this point"
      onClick={(ev) => {
        // Stop the click from also triggering the canvas mouse-up that
        // would add a new prompt underneath.
        ev.stopPropagation()
        removeClickAt(index)
      }}
      className={`absolute h-[10px] w-[10px] rounded-[50%] ${name} outline-8 outline pointer-events-auto cursor-pointer transition hover:scale-150`}
      style={{
        left: x,
        top: y,
        transform: "translate(-50%, -50%)",
      }}
    />
  )
}

const InteractiveSegPoints = () => {
  const clicks = useStore((state) => state.interactiveSegState.clicks)

  return (
    <div className="absolute h-full w-full overflow-hidden pointer-events-none">
      {clicks.map((click, index) => {
        return (
          <Item
            key={click[3]}
            x={click[0]}
            y={click[1]}
            positive={click[2] === 1}
            index={index}
          />
        )
      })}
    </div>
  )
}

const InteractiveSeg = () => {
  return (
    <div>
      <InteractiveSegConfirmActions />
      {/* <InteractiveSegReplaceModal /> */}
    </div>
  )
}

export { InteractiveSeg, InteractiveSegPoints }
