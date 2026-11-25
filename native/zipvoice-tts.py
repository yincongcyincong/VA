"""Keep the ZipVoice model loaded and synthesize WAV audio locally."""

from array import array
from base64 import b64encode
from functools import lru_cache
from io import BytesIO
import json
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
import wave

try:
    import sherpa_onnx
except ImportError:
    sherpa_onnx = None


def reply(**message):
    print(json.dumps(message, ensure_ascii=False), flush=True)


def load_model(directory):
    zipvoice = {
        "encoder": str(directory / "encoder.int8.onnx"),
        "decoder": str(directory / "decoder.int8.onnx"),
        "vocoder": str(directory / "vocos_24khz.onnx"),
        "lexicon": str(directory / "lexicon.txt"),
        "tokens": str(directory / "tokens.txt"),
        "data_dir": str(directory / "espeak-ng-data"),
    }
    if not all(Path(file).exists() for file in zipvoice.values()):
        reply(id=0, error="missing_model")
        return
    if sherpa_onnx is None:
        reply(id=0, error="missing_engine")
        return
    try:
        config = sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                zipvoice=sherpa_onnx.OfflineTtsZipvoiceModelConfig(**zipvoice),
                num_threads=4,
                provider="cpu",
            ),
            max_num_sentences=1,
        )
        if config.validate():
            return sherpa_onnx.OfflineTts(config)
    except Exception:
        pass
    reply(id=0, error="load_failed")


class ReferenceTooLong(ValueError):
    pass


class ReferenceConverterUnavailable(Exception):
    pass


def read_reference_wave(path):
    with wave.open(path, "rb") as wav:
        sample_rate = wav.getframerate()
        frames = wav.getnframes()
        if frames > sample_rate * 30:
            raise ReferenceTooLong()
        if not frames or sample_rate != 24000 or wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            raise wave.Error("Expected 24 kHz mono PCM with 16-bit samples")
        samples = array("h")
        samples.frombytes(wav.readframes(frames))
    if sys.byteorder != "little":
        samples.byteswap()
    return [sample / 32768 for sample in samples], sample_rate


@lru_cache(maxsize=1)
def read_reference(path, _revision):
    # The revision invalidates the cache when a file is replaced at the same path.
    windows = sys.platform == "win32"
    if windows and Path(path).suffix.lower() == ".wav":
        try:
            return read_reference_wave(path)
        except (EOFError, wave.Error):
            pass
    with TemporaryDirectory(prefix="va-zipvoice-") as folder:
        output = str(Path(folder) / "reference.wav")
        if windows:
            converter = shutil.which("ffmpeg.exe")
            if not converter:
                raise ReferenceConverterUnavailable()
            command = [converter, "-nostdin", "-loglevel", "error", "-i", path, "-map", "0:a:0",
                       "-t", "31", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", output]
        else:
            command = ["/usr/bin/afconvert", "-f", "WAVE", "-d", "LEI16@24000", "-c", "1", path, output]
        subprocess.run(command, check=True, timeout=5, capture_output=True,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if windows else 0)
        return read_reference_wave(output)


def synthesize(engine, request, samples, sample_rate):
    generation = sherpa_onnx.GenerationConfig()
    generation.reference_audio = samples
    generation.reference_sample_rate = sample_rate
    generation.reference_text = request["reference"]["text"]
    generation.num_steps = 4
    generation.speed = 1 + request["rate"] / 100
    audio = engine.generate(request["text"], generation)
    if not len(audio.samples) or audio.sample_rate <= 0:
        raise ValueError("Empty audio")
    gain = 32768 * (1 + request["volume"] / 100)
    pcm = array("h", (max(-32768, min(32767, int(sample * gain))) for sample in audio.samples))
    if sys.byteorder != "little":
        pcm.byteswap()
    output = BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setparams((1, 2, audio.sample_rate, 0, "NONE", "not compressed"))
        wav.writeframes(pcm.tobytes())
    return b64encode(output.getbuffer()).decode("ascii")


def main():
    model = load_model(Path(sys.argv[1]))
    if model is None:
        return
    reply(id=0, ok=True)
    for line in sys.stdin:
        request = json.loads(line)
        request_id = request["id"]
        reference = request.get("reference")
        if reference:
            try:
                samples, sample_rate = read_reference(reference["path"], reference["revision"])
            except ReferenceTooLong:
                reply(id=request_id, error="long_reference")
                continue
            except ReferenceConverterUnavailable:
                reply(id=request_id, error="converter_missing")
                continue
            except (OSError, EOFError, wave.Error, ValueError, subprocess.SubprocessError):
                reply(id=request_id, error="invalid_reference")
                continue
        if "text" not in request:
            reply(id=request_id, ok=True)
            continue
        try:
            audio = synthesize(model, request, samples, sample_rate)
            reply(id=request_id, ok=True, audio=audio)
        except Exception:
            reply(id=request_id, ok=False)


if __name__ == "__main__":
    main()
