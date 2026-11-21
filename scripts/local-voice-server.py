"""Run the local MLX voice model using VA's reference-audio request format."""

import argparse
import io
import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import numpy as np
import soundfile
from mlx_audio.tts.utils import load_model


def synthesize(model, text, sample, transcript, language):
    buffers = []
    sample_rate = None
    for result in model.generate(
        text=text, ref_audio=str(sample), ref_text=transcript,
        lang_code=language, max_tokens=1600, verbose=False,
    ):
        buffers.append(np.asarray(result.audio))
        sample_rate = result.sample_rate
    if not buffers or not sample_rate:
        raise RuntimeError("No audio produced")
    signal = np.concatenate(buffers)
    if not signal.size or not np.isfinite(signal).all():
        raise RuntimeError("Invalid audio produced")
    data = io.BytesIO()
    soundfile.write(data, signal, sample_rate, format="WAV", subtype="PCM_16")
    return data.getvalue()


def serve(model, references, port):
    class VoiceHandler(BaseHTTPRequestHandler):
        def log_message(self, _message, *_args):
            pass

        def send_data(self, status, media_type, data):
            try:
                self.send_response(status)
                self.send_header("Content-Type", media_type)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            if self.path != "/health":
                return self.send_error(404)
            self.send_data(200, "application/json", b'{"ok":true,"engine":"qwen3-tts-mlx"}')

        def do_POST(self):
            if self.path != "/tts":
                return self.send_error(404)
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > 8192:
                    raise ValueError("Invalid size")
                request = json.loads(self.rfile.read(length))
                text = request["text"].strip()
                transcript = request["prompt_text"].strip()
                sample = Path(request["ref_audio_path"]).resolve(strict=True)
                if (not text or len(text) > 300 or not transcript or len(transcript) > 500
                        or not sample.is_relative_to(references) or sample.suffix.lower() != ".wav"
                        or not sample.is_file() or sample.stat().st_size > 700_000
                        or request.get("media_type", "wav") != "wav"):
                    raise ValueError("Invalid audio or text")
                lang = request.get("text_lang", "auto")
                language = {"zh": "chinese", "en": "english", "ja": "japanese", "ko": "korean"}.get(lang, "auto")
            except (OSError, RuntimeError, ValueError, AttributeError, TypeError, KeyError):
                return self.send_error(400, "Invalid voice request")
            started = time.monotonic()
            try:
                data = synthesize(model, text, sample, transcript, language)
            except Exception as error:
                print(f"synthesis failed: {type(error).__name__}: {error}", flush=True)
                return self.send_error(500, "Local voice generation failed")
            print(f"synthesized {len(text)} characters, {len(data)} WAV bytes in {time.monotonic() - started:.1f}s", flush=True)
            self.send_data(200, "audio/wav", data)

    with HTTPServer(("127.0.0.1", port), VoiceHandler) as server:
        print(f"Qwen3-TTS ready on 127.0.0.1:{port}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--reference-directory", type=Path, required=True)
    parser.add_argument("--port", type=int, default=9880)
    args = parser.parse_args()
    directory = args.reference_directory.resolve(strict=True)
    serve(load_model(str(args.model.resolve(strict=True))), directory, args.port)
