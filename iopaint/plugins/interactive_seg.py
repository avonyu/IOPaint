import hashlib
from typing import List

import cv2
import numpy as np
import torch
from loguru import logger

from iopaint.helper import download_model
from iopaint.plugins.base_plugin import BasePlugin
from iopaint.plugins.segment_anything import SamPredictor, sam_model_registry
from iopaint.plugins.segment_anything.predictor_hq import SamHQPredictor
from iopaint.plugins.segment_anything2.build_sam import build_sam2
from iopaint.plugins.segment_anything2.sam2_image_predictor import SAM2ImagePredictor
from iopaint.schema import RunPluginRequest

# 从小到大
SEGMENT_ANYTHING_MODELS = {
    "vit_b": {
        "url": "https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth",
        "md5": "01ec64d29a2fca3f0661936605ae66f8",
    },
    "vit_l": {
        "url": "https://dl.fbaipublicfiles.com/segment_anything/sam_vit_l_0b3195.pth",
        "md5": "0b3195507c641ddb6910d2bb5adee89c",
    },
    "vit_h": {
        "url": "https://dl.fbaipublicfiles.com/segment_anything/sam_vit_h_4b8939.pth",
        "md5": "4b8939a88964f0f4ff5f5b2642c598a6",
    },
    "mobile_sam": {
        "url": "https://github.com/Sanster/models/releases/download/MobileSAM/mobile_sam.pt",
        "md5": "f3c0d8cda613564d499310dab6c812cd",
    },
    "sam_hq_vit_b": {
        "url": "https://huggingface.co/lkeab/hq-sam/resolve/main/sam_hq_vit_b.pth",
        "md5": "c6b8953247bcfdc8bb8ef91e36a6cacc",
    },
    "sam_hq_vit_l": {
        "url": "https://huggingface.co/lkeab/hq-sam/resolve/main/sam_hq_vit_l.pth",
        "md5": "08947267966e4264fb39523eccc33f86",
    },
    "sam_hq_vit_h": {
        "url": "https://huggingface.co/lkeab/hq-sam/resolve/main/sam_hq_vit_h.pth",
        "md5": "3560f6b6a5a6edacd814a1325c39640a",
    },
    "sam2_tiny": {
        "url": "https://dl.fbaipublicfiles.com/segment_anything_2/072824/sam2_hiera_tiny.pt",
        "md5": "99eacccce4ada0b35153d4fd7af05297",
    },
    "sam2_small": {
        "url": "https://dl.fbaipublicfiles.com/segment_anything_2/072824/sam2_hiera_small.pt",
        "md5": "7f320dbeb497330a2472da5a16c7324d",
    },
    "sam2_base": {
        "url": "https://dl.fbaipublicfiles.com/segment_anything_2/072824/sam2_hiera_base_plus.pt",
        "md5": "09dc5a3d7719f64aaea1d37341ef26f2",
    },
    "sam2_large": {
        "url": "https://dl.fbaipublicfiles.com/segment_anything_2/072824/sam2_hiera_large.pt",
        "md5": "08083462423be3260cd6a5eef94dc01c",
    },
    "sam2_1_tiny": {
        "url": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt",
        "md5": "6aa6761c9da74fbaa74b4c790a0a2007",
    },
    "sam2_1_small": {
        "url": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt",
        "md5": "51713b3d1994696d27f35f9c6de6f5ef",
    },
    "sam2_1_base": {
        "url": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_base_plus.pt",
        "md5": "ec7bd7d23d280d5e3cfa45984c02eda5",
    },
    "sam2_1_large": {
        "url": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt",
        "md5": "2b30654b6112c42a115563c638d238d9",
    },
}


def _keep_clicked_components(
    binary: np.ndarray, points: List[List[float]], labels: List[int]
) -> np.ndarray:
    """Drop foreground blobs that no positive click landed on.

    SAM sometimes returns a few stray specks far from the object (e.g. a
    patch of background that scored just above the threshold). Those specks
    would otherwise be inpaint targets the user never asked for. We keep
    only the components that contain at least one positive prompt, which is
    exactly the set the user indicated.
    """
    if binary.max() == 0:
        return binary

    num, comp = cv2.connectedComponents(binary, connectivity=8)
    if num <= 2:  # only background + one component
        return binary

    keep = np.zeros(num, dtype=bool)
    h, w = binary.shape
    for (x, y), label in zip(points, labels):
        if label != 1:
            continue
        # Clamp: a click can land a pixel outside the frame after zooming.
        xi = int(np.clip(round(float(x)), 0, w - 1))
        yi = int(np.clip(round(float(y)), 0, h - 1))
        cid = comp[yi, xi]
        if cid != 0:
            keep[cid] = True

    if not keep.any():
        # No positive click landed inside the mask (e.g. only negative
        # points, or all clicks missed). Fall back to keeping the largest
        # component rather than returning an empty selection.
        areas = np.bincount(comp.ravel(), minlength=num)
        areas[0] = 0
        keep[int(np.argmax(areas))] = True

    return keep[comp].astype(np.uint8)


def _fill_enclosed_holes(binary: np.ndarray) -> np.ndarray:
    """Fill background regions fully enclosed by the mask.

    A hole is a connected background component that does not reach the image
    border. Those are pinholes produced by noisy logits inside the object
    (eyes, nostrils, fabric gaps, hair strands) and are never intentional.
    Background that touches the border is genuine outside area and is kept.
    """
    if binary.max() == 0:
        return binary

    # Flood the background inwards from the border; whatever background is
    # not reached is enclosed.
    h, w = binary.shape
    # Pad by 1 so the flood starts outside the image and covers all edges.
    inv = np.pad(1 - binary, 1, mode="constant", constant_values=1)
    ff_mask = np.zeros((h + 4, w + 4), dtype=np.uint8)
    # Seed at the padded corner; newVal=0 marks "outside-connected" pixels.
    cv2.floodFill(inv, ff_mask, (0, 0), 0)
    # After the fill, `inv` is 0 where the background connects to the border
    # and still 1 inside enclosed holes.
    holes = inv[1:-1, 1:-1] > 0
    out = binary.copy()
    out[holes] = 1
    return out


class InteractiveSeg(BasePlugin):
    name = "InteractiveSeg"
    support_gen_mask = True

    def __init__(self, model_name, device):
        super().__init__()
        self.model_name = model_name
        self.device = device
        self._init_session(model_name)

    def _init_session(self, model_name: str):
        model_path = download_model(
            SEGMENT_ANYTHING_MODELS[model_name]["url"],
            SEGMENT_ANYTHING_MODELS[model_name]["md5"],
        )
        logger.info(f"SegmentAnything model path: {model_path}")
        if "sam_hq" in model_name:
            self.predictor = SamHQPredictor(
                sam_model_registry[model_name](checkpoint=model_path).to(self.device)
            )
        elif model_name.startswith("sam2"):
            sam2_model = build_sam2(
                model_name, ckpt_path=model_path, device=self.device
            )
            self.predictor = SAM2ImagePredictor(sam2_model)
        else:
            self.predictor = SamPredictor(
                sam_model_registry[model_name](checkpoint=model_path).to(self.device)
            )
        self.prev_img_md5 = None

    def switch_model(self, new_model_name):
        if self.model_name == new_model_name:
            return

        logger.info(
            f"Switching InteractiveSeg model from {self.model_name} to {new_model_name}"
        )
        self._init_session(new_model_name)
        self.model_name = new_model_name

    def gen_mask(self, rgb_np_img, req: RunPluginRequest) -> np.ndarray:
        img_md5 = hashlib.md5(req.image.encode("utf-8")).hexdigest()
        return self.forward(rgb_np_img, req.clicks, img_md5, req.seg_grow_radius)

    @torch.inference_mode()
    def forward(self, rgb_np_img, clicks: List[List], img_md5: str, grow_radius: int = 0):
        input_point = []
        input_label = []
        for click in clicks:
            x = click[0]
            y = click[1]
            input_point.append([x, y])
            input_label.append(click[2])

        if img_md5 and img_md5 != self.prev_img_md5:
            self.prev_img_md5 = img_md5
            self.predictor.set_image(rgb_np_img)

        # ``return_logits=True`` is essential: without it the predictor
        # hard-thresholds the mask (``masks > 0``) and hands back a 0/1 array,
        # which throws away every bit of sub-pixel edge information and makes
        # the overlay look like 1-pixel stair-steps. With logits we get the
        # model's real confidence field and can build a smooth alpha ramp.
        #
        # ``multimask_output=True`` matters just as much. A bare click is an
        # *ambiguous* prompt, and upstream's own demo only uses ``False`` for
        # non-ambiguous (multi-point) prompts. With ``False`` the decoder
        # returns the single-mask token, which is the weakest of the three
        # heads and leaves the logits hovering around 0 across low-contrast
        # regions -- that is what punches pinholes through the middle of the
        # selection. With ``True`` we get all three candidates plus the
        # model's own quality score, so we can pick the best one.
        masks, scores, _ = self.predictor.predict(
            point_coords=np.array(input_point),
            point_labels=np.array(input_label),
            multimask_output=True,
            return_logits=True,
        )
        # Pick the highest-scoring candidate, as upstream does.
        best = int(np.argmax(np.asarray(scores).reshape(-1)))
        logits = masks[best]
        if logits.ndim == 3:
            logits = logits[0]
        logits = logits.astype(np.float32)

        # ---- Enforce a contiguous mask -------------------------------
        # SAM's logits are noisy around ambiguous regions (hair strands,
        # fabric texture, facial features). Thresholding them directly
        # punches pinholes through the middle of the object, which is
        # never what the user wants when they clicked "select this
        # thing". We therefore clean the *binary decision* by
        # connectivity, and only use the logits to anti-alias the
        # resulting outline.
        binary = (logits > 0.0).astype(np.uint8)
        binary = _keep_clicked_components(binary, input_point, input_label)
        binary = _fill_enclosed_holes(binary)

        if grow_radius > 0:
            # Grow the selection past the object's own silhouette.
            #
            # A mask that ends exactly on the subject boundary gives the
            # inpainter no pixels of the object to work from, so it has to
            # guess where the true edge was -- that is what leaves a coloured
            # halo around the result. Overlapping the subject by a few pixels
            # gives the model real foreground context and the seam disappears.
            k = 2 * int(grow_radius) + 1
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
            binary = cv2.dilate(binary, kernel, iterations=1)

        # Soft alpha: solid inside the cleaned region, clear outside, with a
        # ~1 px ramp along the contour so the browser can anti-alias it.
        #
        # The ramp is derived from a *signed distance* to the cleaned outline
        # rather than from the raw logits. Deriving it from the logits looks
        # tempting but is wrong: the holes we just filled have strongly
        # negative logits, so a logit-derived alpha would drop them again the
        # moment anything downstream re-thresholds at 0.5. Distance keeps the
        # cleaned topology authoritative and confines the softness to the
        # boundary, which is the only place it is wanted.
        # Start fully opaque inside the cleaned region...
        alpha = binary.astype(np.float32)
        # ...then feather only the outermost ring of the boundary, so the
        # contour gets a one-pixel anti-aliased ramp while the interior stays
        # solid. Using an explicit ring (rather than a signed-distance ramp)
        # matters because a distance transform on a binary mask jumps from
        # ~-0.96 straight to ~+0.96 across the border and yields no
        # intermediate values to interpolate.
        eroded = cv2.erode(binary, np.ones((3, 3), np.uint8), iterations=1)
        boundary = (binary > 0) & (eroded == 0)
        alpha[boundary] = 0.5
        return np.clip(alpha, 0.0, 1.0).astype(np.float32)
