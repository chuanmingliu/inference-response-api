#!/usr/bin/env python3
"""Launch pinned SGLang with bounded native Responses retention and admission."""

from contextlib import asynccontextmanager
import logging
import os
import sys

from response_store import BoundedResponseStore, Limits, ResponsesAdmissionMiddleware


def configure_app(app):
    native_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application):
        async with native_lifespan(application) as state:
            handler = getattr(application.state, "openai_serving_responses", None)
            if handler is None or not handler.enable_response_store:
                raise RuntimeError("Bounded Responses requires the native handler and --enable-response-store")
            controller = BoundedResponseStore(handler)
            application.state.bounded_responses = controller
            await controller.start()
            logging.getLogger(__name__).info("Native Responses retention: %s", Limits())
            try:
                yield state
            finally:
                await controller.close()

    app.router.lifespan_context = lifespan
    app.add_middleware(ResponsesAdmissionMiddleware)


def main():
    from sglang.launch_server import run_server
    from sglang.srt.arg_groups.overrides import resolving_view
    from sglang.srt.plugins import load_plugins
    from sglang.srt.server_args import prepare_server_args
    from sglang.srt.utils import kill_process_tree

    load_plugins()
    args = prepare_server_args(sys.argv[1:])
    args.resolve_once()
    cfg = resolving_view(args)
    if (cfg.tokenizer_worker_num != 1 or cfg.encoder_only or cfg.smg_grpc_mode
            or cfg.grpc_mode or cfg.use_ray or cfg.grpc_port is not None or cfg.sidecar is not None):
        raise SystemExit("The bounded Responses launcher supports one standalone HTTP tokenizer only.")
    from sglang.srt.entrypoints.http_server import app

    configure_app(app)
    try:
        run_server(args)
    finally:
        kill_process_tree(os.getpid(), include_parent=False)


if __name__ == "__main__":
    main()
