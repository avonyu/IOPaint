# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.

# This source code is licensed under the license found in the
# LICENSE file in the root directory of this source tree.

import warnings

import torch
import torch.nn as nn
import torch.nn.functional as F
from torchvision.transforms import Normalize, Resize, ToTensor


def _gather_label_area(labels: torch.Tensor, areas: torch.Tensor) -> torch.Tensor:
    """Expand per-label areas to a per-pixel map.

    ``labels`` is ``(B, H, W)`` of component ids and ``areas`` is
    ``(B, num_labels)``. Returns ``(B, H, W)`` where each entry is the area
    of the component that pixel belongs to.
    """
    b, h, w = labels.shape
    num_labels = areas.shape[1]
    flat_idx = labels.reshape(b, -1).long().clamp_(0, num_labels - 1)
    gathered = torch.gather(areas, 1, flat_idx)
    return gathered.reshape(b, h, w)


class SAM2Transforms(nn.Module):
    def __init__(
        self, resolution, mask_threshold, max_hole_area=0.0, max_sprinkle_area=0.0
    ):
        """
        Transforms for SAM2.
        """
        super().__init__()
        self.resolution = resolution
        self.mask_threshold = mask_threshold
        self.max_hole_area = max_hole_area
        self.max_sprinkle_area = max_sprinkle_area
        self.mean = [0.485, 0.456, 0.406]
        self.std = [0.229, 0.224, 0.225]
        self.to_tensor = ToTensor()
        self.transforms = torch.jit.script(
            nn.Sequential(
                Resize((self.resolution, self.resolution)),
                Normalize(self.mean, self.std),
            )
        )

    def __call__(self, x):
        x = self.to_tensor(x)
        return self.transforms(x)

    def forward_batch(self, img_list):
        img_batch = [self.transforms(self.to_tensor(img)) for img in img_list]
        img_batch = torch.stack(img_batch, dim=0)
        return img_batch

    def transform_coords(
        self, coords: torch.Tensor, normalize=False, orig_hw=None
    ) -> torch.Tensor:
        """
        Expects a torch tensor with length 2 in the last dimension. The coordinates can be in absolute image or normalized coordinates,
        If the coords are in absolute image coordinates, normalize should be set to True and original image size is required.

        Returns
            Un-normalized coordinates in the range of [0, 1] which is expected by the SAM2 model.
        """
        if normalize:
            assert orig_hw is not None
            h, w = orig_hw
            coords = coords.clone()
            coords[..., 0] = coords[..., 0] / w
            coords[..., 1] = coords[..., 1] / h

        coords = coords * self.resolution  # unnormalize coords
        return coords

    def transform_boxes(
        self, boxes: torch.Tensor, normalize=False, orig_hw=None
    ) -> torch.Tensor:
        """
        Expects a tensor of shape Bx4. The coordinates can be in absolute image or normalized coordinates,
        if the coords are in absolute image coordinates, normalize should be set to True and original image size is required.
        """
        boxes = self.transform_coords(boxes.reshape(-1, 2, 2), normalize, orig_hw)
        return boxes

    def postprocess_masks(self, masks: torch.Tensor, orig_hw) -> torch.Tensor:
        """
        Perform PostProcessing on output masks.

        The mask decoder emits 256x256 logits; this upsamples them to the
        original image size with bilinear interpolation so the mask has
        real sub-pixel structure instead of blocky 256x256 cells. The
        optional connected-component cleanups (hole / sprinkle filling)
        run on the low-res logits, where they are cheap and unambiguous.
        """
        from .misc import get_connected_components

        masks = masks.float()
        input_masks = masks
        mask_flat = masks.flatten(0, 1).unsqueeze(1)
        try:
            if self.max_hole_area > 0:
                # Holes are connected components in the background whose
                # area is below max_hole_area. Promote them to foreground by
                # writing a small positive score just over the threshold.
                labels, areas = get_connected_components(
                    mask_flat <= self.mask_threshold
                )
                # ``areas`` is per-label; gather each pixel's own component
                # area before comparing, otherwise the comparison broadcasts
                # across the label axis instead of matching per pixel.
                is_hole = (labels > 0) & (
                    _gather_label_area(labels, areas) <= self.max_hole_area
                )
                is_hole = is_hole.reshape_as(masks)
                masks = torch.where(is_hole, self.mask_threshold + 10.0, masks)

            if self.max_sprinkle_area > 0:
                # Conversely, demote tiny foreground specks to background.
                labels, areas = get_connected_components(
                    mask_flat > self.mask_threshold
                )
                is_hole = (labels > 0) & (
                    _gather_label_area(labels, areas) <= self.max_sprinkle_area
                )
                is_hole = is_hole.reshape_as(masks)
                masks = torch.where(is_hole, self.mask_threshold - 10.0, masks)
        except Exception as e:  # noqa: BLE001 - the CUDA kernel is best-effort
            # Skip the clean-up if the connected-component kernel fails (it
            # needs a CUDA/CPU build with the custom op). Masks stay usable,
            # just without the hole/sprinkle pass.
            warnings.warn(
                f"{e}\n\nSkipping the post-processing step due to the error "
                "above. You can still use SAM 2 and it's OK to ignore the "
                "error above, although some post-processing functionality "
                "may be limited (which doesn't affect the results in most "
                "cases).",
                category=UserWarning,
                stacklevel=2,
            )
            masks = input_masks

        masks = F.interpolate(masks, orig_hw, mode="bilinear", align_corners=False)
        return masks
