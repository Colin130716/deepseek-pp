"""Convenience launcher: python run.py [--port 8765]"""

from __future__ import annotations

import argparse

import uvicorn

from app import DEFAULT_PORT, create_app


def main() -> None:
    parser = argparse.ArgumentParser(description="DeepCompanion local workspace server")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args()
    # Host is intentionally hard-coded to loopback for security.
    uvicorn.run(create_app(), host="127.0.0.1", port=args.port, log_level="info")


if __name__ == "__main__":
    main()
