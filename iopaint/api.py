import asyncio
import base64
import io
import os
import threading
import time
import traceback
import uuid
import zipfile
from collections import OrderedDict
from pathlib import Path
from typing import Optional, Dict, List

import cv2
import numpy as np
import socketio
import torch

try:
    torch._C._jit_override_can_fuse_on_cpu(False)
    torch._C._jit_override_can_fuse_on_gpu(False)
    torch._C._jit_set_texpr_fuser_enabled(False)
    torch._C._jit_set_nvfuser_enabled(False)
    torch._C._jit_set_profiling_mode(False)
except:
    pass

import uvicorn
from PIL import Image
from fastapi import APIRouter, FastAPI, Request, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles
from loguru import logger
from socketio import AsyncServer

from iopaint.file_manager import FileManager
from iopaint.helper import (
    load_img,
    decode_base64_to_image,
    pil_to_bytes,
    numpy_to_bytes,
    concat_alpha_channel,
    gen_frontend_mask,
    adjust_mask,
)
from iopaint.model.utils import torch_gc
from iopaint.model_manager import ModelManager
from iopaint.plugins import build_plugins, RealESRGANUpscaler, InteractiveSeg
from iopaint.plugins.base_plugin import BasePlugin
from iopaint.plugins.remove_bg import RemoveBG
from iopaint.schema import (
    GenInfoResponse,
    ApiConfig,
    ServerConfigResponse,
    SwitchModelRequest,
    InpaintRequest,
    BatchInpaintRequest,
    BatchInpaintResponse,
    BatchResultItem,
    RunPluginRequest,
    SDSampler,
    PluginInfo,
    AdjustMaskRequest,
    RemoveBGModel,
    SwitchPluginModelRequest,
    ModelInfo,
    InteractiveSegModel,
    RealESRGANModel,
)

CURRENT_DIR = Path(__file__).parent.absolute().resolve()
WEB_APP_DIR = CURRENT_DIR / "web_app"


def place_mask_by_anchor(
    mask: np.ndarray,
    width: int,
    height: int,
    anchor_right: bool,
    anchor_bottom: bool,
) -> np.ndarray:
    """Place a shared mask onto a width×height canvas anchored to a corner.

    The mask is only translated (never resized), keeping its pixel size and its
    offset relative to the chosen corner.
    """
    src_h, src_w = mask.shape[:2]
    offset_x = width - src_w if anchor_right else 0
    offset_y = height - src_h if anchor_bottom else 0

    target = np.zeros((height, width), dtype=np.uint8)
    x0 = max(0, offset_x)
    y0 = max(0, offset_y)
    sx0 = max(0, -offset_x)
    sy0 = max(0, -offset_y)
    copy_w = min(src_w - sx0, width - x0)
    copy_h = min(src_h - sy0, height - y0)
    if copy_w > 0 and copy_h > 0:
        target[y0 : y0 + copy_h, x0 : x0 + copy_w] = mask[
            sy0 : sy0 + copy_h, sx0 : sx0 + copy_w
        ]
    return target


# 最近几批的批量结果缓存（用于结果预览后再打包下载）
_BATCH_CACHE: "OrderedDict[str, OrderedDict[str, bytes]]" = OrderedDict()
_BATCH_CACHE_MAX = 3


def _cache_batch(batch_id: str, files: "OrderedDict[str, bytes]") -> None:
    _BATCH_CACHE[batch_id] = files
    _BATCH_CACHE.move_to_end(batch_id)
    while len(_BATCH_CACHE) > _BATCH_CACHE_MAX:
        _BATCH_CACHE.popitem(last=False)


def api_middleware(app: FastAPI):
    rich_available = False
    try:
        if os.environ.get("WEBUI_RICH_EXCEPTIONS", None) is not None:
            import anyio  # importing just so it can be placed on silent list
            import starlette  # importing just so it can be placed on silent list
            from rich.console import Console

            console = Console()
            rich_available = True
    except Exception:
        pass

    def handle_exception(request: Request, e: Exception):
        err = {
            "error": type(e).__name__,
            "detail": vars(e).get("detail", ""),
            "body": vars(e).get("body", ""),
            "errors": str(e),
        }
        if not isinstance(
            e, HTTPException
        ):  # do not print backtrace on known httpexceptions
            message = f"API error: {request.method}: {request.url} {err}"
            if rich_available:
                print(message)
                console.print_exception(
                    show_locals=True,
                    max_frames=2,
                    extra_lines=1,
                    suppress=[anyio, starlette],
                    word_wrap=False,
                    width=min([console.width, 200]),
                )
            else:
                traceback.print_exc()
        return JSONResponse(
            status_code=vars(e).get("status_code", 500), content=jsonable_encoder(err)
        )

    @app.middleware("http")
    async def exception_handling(request: Request, call_next):
        try:
            return await call_next(request)
        except Exception as e:
            return handle_exception(request, e)

    @app.exception_handler(Exception)
    async def fastapi_exception_handler(request: Request, e: Exception):
        return handle_exception(request, e)

    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, e: HTTPException):
        return handle_exception(request, e)

    cors_options = {
        "allow_methods": ["*"],
        "allow_headers": ["*"],
        "allow_origins": ["*"],
        "allow_credentials": True,
        "expose_headers": ["X-Seed"],
    }
    app.add_middleware(CORSMiddleware, **cors_options)


global_sio: AsyncServer = None


def diffuser_callback(pipe, step: int, timestep: int, callback_kwargs: Dict = {}):
    # self: DiffusionPipeline, step: int, timestep: int, callback_kwargs: Dict
    # logger.info(f"diffusion callback: step={step}, timestep={timestep}")

    # We use asyncio loos for task processing. Perhaps in the future, we can add a processing queue similar to InvokeAI,
    # but for now let's just start a separate event loop. It shouldn't make a difference for single person use
    asyncio.run(global_sio.emit("diffusion_progress", {"step": step}))
    return {}


class Api:
    def __init__(self, app: FastAPI, config: ApiConfig):
        self.app = app
        self.config = config
        self.router = APIRouter()
        self.queue_lock = threading.Lock()
        api_middleware(self.app)

        self.file_manager = self._build_file_manager()
        self.plugins = self._build_plugins()
        self.model_manager = self._build_model_manager()

        # fmt: off
        self.add_api_route("/api/v1/gen-info", self.api_geninfo, methods=["POST"], response_model=GenInfoResponse)
        self.add_api_route("/api/v1/server-config", self.api_server_config, methods=["GET"],
                           response_model=ServerConfigResponse)
        self.add_api_route("/api/v1/model", self.api_current_model, methods=["GET"], response_model=ModelInfo)
        self.add_api_route("/api/v1/model", self.api_switch_model, methods=["POST"], response_model=ModelInfo)
        self.add_api_route("/api/v1/inputimage", self.api_input_image, methods=["GET"])
        self.add_api_route("/api/v1/inpaint", self.api_inpaint, methods=["POST"])
        self.add_api_route(
            "/api/v1/batch_inpaint",
            self.api_batch_inpaint,
            methods=["POST"],
            response_model=BatchInpaintResponse,
        )
        self.add_api_route(
            "/api/v1/batch_download",
            self.api_batch_download,
            methods=["GET"],
        )
        self.add_api_route("/api/v1/switch_plugin_model", self.api_switch_plugin_model, methods=["POST"])
        self.add_api_route("/api/v1/run_plugin_gen_mask", self.api_run_plugin_gen_mask, methods=["POST"])
        self.add_api_route("/api/v1/run_plugin_gen_image", self.api_run_plugin_gen_image, methods=["POST"])
        self.add_api_route("/api/v1/samplers", self.api_samplers, methods=["GET"])
        self.add_api_route("/api/v1/adjust_mask", self.api_adjust_mask, methods=["POST"])
        self.add_api_route("/api/v1/save_image", self.api_save_image, methods=["POST"])
        if WEB_APP_DIR.is_dir():
            self.app.mount("/", StaticFiles(directory=WEB_APP_DIR, html=True), name="assets")
        else:
            logger.warning(
                f"Web app directory {WEB_APP_DIR} does not exist; "
                "skipping static mount. API endpoints are still available."
            )
        # fmt: on

        global global_sio
        self.sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")
        self.combined_asgi_app = socketio.ASGIApp(self.sio, self.app)
        self.app.mount("/ws", self.combined_asgi_app)
        global_sio = self.sio

    def add_api_route(self, path: str, endpoint, **kwargs):
        return self.app.add_api_route(path, endpoint, **kwargs)

    def api_save_image(self, file: UploadFile):
        # Sanitize filename to prevent path traversal
        safe_filename = Path(file.filename).name  # Get just the filename component

        # Construct the full path within output_dir
        output_path = self.config.output_dir / safe_filename

        # Ensure output directory exists
        if not self.config.output_dir or not self.config.output_dir.exists():
            raise HTTPException(
                status_code=400,
                detail="Output directory not configured or doesn't exist",
            )

        # Read and write the file
        origin_image_bytes = file.file.read()
        with open(output_path, "wb") as fw:
            fw.write(origin_image_bytes)

    def api_current_model(self) -> ModelInfo:
        return self.model_manager.current_model

    def api_switch_model(self, req: SwitchModelRequest) -> ModelInfo:
        if req.name == self.model_manager.name:
            return self.model_manager.current_model
        self.model_manager.switch(req.name)
        return self.model_manager.current_model

    def api_switch_plugin_model(self, req: SwitchPluginModelRequest):
        if req.plugin_name in self.plugins:
            self.plugins[req.plugin_name].switch_model(req.model_name)
            if req.plugin_name == RemoveBG.name:
                self.config.remove_bg_model = req.model_name
            if req.plugin_name == RealESRGANUpscaler.name:
                self.config.realesrgan_model = req.model_name
            if req.plugin_name == InteractiveSeg.name:
                self.config.interactive_seg_model = req.model_name
            torch_gc()

    def api_server_config(self) -> ServerConfigResponse:
        plugins = []
        for it in self.plugins.values():
            plugins.append(
                PluginInfo(
                    name=it.name,
                    support_gen_image=it.support_gen_image,
                    support_gen_mask=it.support_gen_mask,
                )
            )

        return ServerConfigResponse(
            plugins=plugins,
            modelInfos=self.model_manager.scan_models(),
            removeBGModel=self.config.remove_bg_model,
            removeBGModels=RemoveBGModel.values(),
            realesrganModel=self.config.realesrgan_model,
            realesrganModels=RealESRGANModel.values(),
            interactiveSegModel=self.config.interactive_seg_model,
            interactiveSegModels=InteractiveSegModel.values(),
            enableFileManager=self.file_manager is not None,
            enableAutoSaving=self.config.output_dir is not None,
            enableControlnet=self.model_manager.enable_controlnet,
            controlnetMethod=self.model_manager.controlnet_method,
            disableModelSwitch=False,
            isDesktop=False,
            samplers=self.api_samplers(),
        )

    def api_input_image(self) -> FileResponse:
        if self.config.input is None:
            raise HTTPException(status_code=200, detail="No input image configured")

        if self.config.input.is_file():
            return FileResponse(self.config.input)
        raise HTTPException(status_code=404, detail="Input image not found")

    def api_geninfo(self, file: UploadFile) -> GenInfoResponse:
        _, _, info = load_img(file.file.read(), return_info=True)
        parts = info.get("parameters", "").split("Negative prompt: ")
        prompt = parts[0].strip()
        negative_prompt = ""
        if len(parts) > 1:
            negative_prompt = parts[1].split("\n")[0].strip()
        return GenInfoResponse(prompt=prompt, negative_prompt=negative_prompt)

    def api_inpaint(self, req: InpaintRequest):
        image, alpha_channel, infos, ext = decode_base64_to_image(req.image)
        mask, _, _, _ = decode_base64_to_image(req.mask, gray=True)
        logger.info(f"image ext: {ext}")

        mask = cv2.threshold(mask, 127, 255, cv2.THRESH_BINARY)[1]
        if image.shape[:2] != mask.shape[:2]:
            raise HTTPException(
                400,
                detail=f"Image size({image.shape[:2]}) and mask size({mask.shape[:2]}) not match.",
            )

        start = time.time()
        rgb_np_img = self.model_manager(image, mask, req)
        logger.info(f"process time: {(time.time() - start) * 1000:.2f}ms")
        torch_gc()

        rgb_np_img = cv2.cvtColor(rgb_np_img.astype(np.uint8), cv2.COLOR_BGR2RGB)
        rgb_res = concat_alpha_channel(rgb_np_img, alpha_channel)

        res_img_bytes = pil_to_bytes(
            Image.fromarray(rgb_res),
            ext=ext,
            quality=self.config.quality,
            infos=infos,
        )

        asyncio.run(self.sio.emit("diffusion_finish"))

        return Response(
            content=res_img_bytes,
            media_type=f"image/{ext}",
            headers={"X-Seed": str(req.sd_seed)},
        )

    def api_batch_inpaint(self, req: BatchInpaintRequest) -> BatchInpaintResponse:
        """Batch inpaint multiple images sharing one mask.

        Returns the per-image results so the frontend can preview them, and
        caches the raw bytes so the whole batch can be downloaded as a zip later.
        """
        if len(req.images) == 0:
            raise HTTPException(status_code=400, detail="No images provided")

        # 共享 mask：按所选角平移到每张图片（只平移、不缩放）
        mask, _, _, _ = decode_base64_to_image(req.mask, gray=True)
        mask = cv2.threshold(mask, 127, 255, cv2.THRESH_BINARY)[1]
        anchor = req.anchor
        anchor_right = anchor in ("topright", "bottomright")
        anchor_bottom = anchor in ("bottomleft", "bottomright")

        total = len(req.images)
        used_names: Dict[str, int] = {}
        results: List[BatchResultItem] = []
        files: "OrderedDict[str, bytes]" = OrderedDict()

        for index, image_base64 in enumerate(req.images):
            try:
                image, alpha_channel, infos, _ext = decode_base64_to_image(image_base64)
            except Exception as e:
                logger.warning(f"Skip invalid image at index {index}: {e}")
                continue

            height, width = image.shape[:2]
            image_mask = place_mask_by_anchor(
                mask, width, height, anchor_right, anchor_bottom
            )

            raw_name = (
                req.filenames[index] if index < len(req.filenames) else ""
            ) or f"image_{index + 1}"
            stem = Path(raw_name).stem or f"image_{index + 1}"
            if stem in used_names:
                used_names[stem] += 1
                stem = f"{stem}_{used_names[stem]}"
            else:
                used_names[stem] = 0
            file_name = f"{stem}.png"

            logger.info(f"Batch inpainting {index + 1}/{total}: {raw_name}")
            asyncio.run(
                self.sio.emit(
                    "batch_progress",
                    {"current": index + 1, "total": total},
                )
            )

            start = time.time()
            rgb_np_img = self.model_manager(image, image_mask, req.config)
            logger.info(f"process time: {(time.time() - start) * 1000:.2f}ms")
            torch_gc()

            rgb_np_img = cv2.cvtColor(rgb_np_img.astype(np.uint8), cv2.COLOR_BGR2RGB)
            rgb_res = concat_alpha_channel(rgb_np_img, alpha_channel)
            img_bytes = pil_to_bytes(
                Image.fromarray(rgb_res),
                ext="png",
                quality=self.config.quality,
                infos=infos,
            )

            files[file_name] = img_bytes
            results.append(
                BatchResultItem(
                    index=index,
                    name=file_name,
                    image="data:image/png;base64,"
                    + base64.b64encode(img_bytes).decode(),
                )
            )

        asyncio.run(self.sio.emit("batch_finish", {"total": total}))

        batch_id = uuid.uuid4().hex
        _cache_batch(batch_id, files)
        return BatchInpaintResponse(batch_id=batch_id, results=results)

    def api_batch_download(self, batch_id: str):
        files = _BATCH_CACHE.get(batch_id)
        if files is None:
            raise HTTPException(status_code=404, detail="Batch results not found")

        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
            for name, data in files.items():
                zip_file.writestr(name, data)
        zip_buffer.seek(0)
        return Response(
            content=zip_buffer.read(),
            media_type="application/zip",
            headers={
                "Content-Disposition": 'attachment; filename="iopaint_batch_results.zip"'
            },
        )

    def api_run_plugin_gen_image(self, req: RunPluginRequest):
        ext = "png"
        if req.name not in self.plugins:
            raise HTTPException(status_code=422, detail="Plugin not found")
        if not self.plugins[req.name].support_gen_image:
            raise HTTPException(
                status_code=422, detail="Plugin does not support output image"
            )
        rgb_np_img, alpha_channel, infos, _ = decode_base64_to_image(req.image)
        bgr_or_rgba_np_img = self.plugins[req.name].gen_image(rgb_np_img, req)
        torch_gc()

        if bgr_or_rgba_np_img.shape[2] == 4:
            rgba_np_img = bgr_or_rgba_np_img
        else:
            rgba_np_img = cv2.cvtColor(bgr_or_rgba_np_img, cv2.COLOR_BGR2RGB)
            rgba_np_img = concat_alpha_channel(rgba_np_img, alpha_channel)

        return Response(
            content=pil_to_bytes(
                Image.fromarray(rgba_np_img),
                ext=ext,
                quality=self.config.quality,
                infos=infos,
            ),
            media_type=f"image/{ext}",
        )

    def api_run_plugin_gen_mask(self, req: RunPluginRequest):
        if req.name not in self.plugins:
            raise HTTPException(status_code=422, detail="Plugin not found")
        if not self.plugins[req.name].support_gen_mask:
            raise HTTPException(
                status_code=422, detail="Plugin does not support output image"
            )
        rgb_np_img, _, _, _ = decode_base64_to_image(req.image)
        bgr_or_gray_mask = self.plugins[req.name].gen_mask(rgb_np_img, req)
        torch_gc()
        res_mask = gen_frontend_mask(bgr_or_gray_mask)
        return Response(
            content=numpy_to_bytes(res_mask, "png"),
            media_type="image/png",
        )

    def api_samplers(self) -> List[str]:
        return [member.value for member in SDSampler.__members__.values()]

    def api_adjust_mask(self, req: AdjustMaskRequest):
        mask, _, _, _ = decode_base64_to_image(req.mask, gray=True)
        mask = adjust_mask(mask, req.kernel_size, req.operate)
        return Response(content=numpy_to_bytes(mask, "png"), media_type="image/png")

    def launch(self):
        self.app.include_router(self.router)
        uvicorn.run(
            self.combined_asgi_app,
            host=self.config.host,
            port=self.config.port,
            timeout_keep_alive=999999999,
        )

    def _build_file_manager(self) -> Optional[FileManager]:
        if self.config.input and self.config.input.is_dir():
            logger.info(
                f"Input is directory, initialize file manager {self.config.input}"
            )

            return FileManager(
                app=self.app,
                input_dir=self.config.input,
                mask_dir=self.config.mask_dir,
                output_dir=self.config.output_dir,
            )
        return None

    def _build_plugins(self) -> Dict[str, BasePlugin]:
        return build_plugins(
            self.config.enable_interactive_seg,
            self.config.interactive_seg_model,
            self.config.interactive_seg_device,
            self.config.enable_remove_bg,
            self.config.remove_bg_device,
            self.config.remove_bg_model,
            self.config.enable_anime_seg,
            self.config.enable_realesrgan,
            self.config.realesrgan_device,
            self.config.realesrgan_model,
            self.config.enable_gfpgan,
            self.config.gfpgan_device,
            self.config.enable_restoreformer,
            self.config.restoreformer_device,
            self.config.no_half,
        )

    def _build_model_manager(self):
        return ModelManager(
            name=self.config.model,
            device=torch.device(self.config.device),
            no_half=self.config.no_half,
            low_mem=self.config.low_mem,
            disable_nsfw=self.config.disable_nsfw_checker,
            sd_cpu_textencoder=self.config.cpu_textencoder,
            local_files_only=self.config.local_files_only,
            cpu_offload=self.config.cpu_offload,
            callback=diffuser_callback,
        )
