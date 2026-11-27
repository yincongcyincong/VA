"""Local SenseVoice + Silero VAD. Capture is opt-in, PCM stays in memory."""
import argparse
import base64
import json
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading


def emit(event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


def load_models(folder):
    import sherpa_onnx
    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(folder / 'model.int8.onnx'), tokens=str(folder / 'tokens.txt'),
        language='auto', use_itn=True, num_threads=2, provider='cpu')
    config = sherpa_onnx.VadModelConfig()
    config.sample_rate = 16000
    config.silero_vad.model = str(folder / 'silero_vad.onnx')
    config.silero_vad.min_silence_duration = 0.6
    config.silero_vad.min_speech_duration = 0.25
    config.silero_vad.max_speech_duration = 10
    return recognizer, sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=30)


def recognize(recognizer, samples):
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, samples)
    recognizer.decode_stream(stream)
    return re.sub(r'<\|[^|]*\|>', '', stream.result.text).strip()


def drain_segments(recognizer, vad, microphone=False):
    while not vad.empty():
        text = recognize(recognizer, vad.front.samples)
        vad.pop()
        if text:
            emit({'type': 'user-input' if microphone else 'caption', 'text': text[:2000], 'final': True})
            if microphone:
                return True
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('model_directory', type=Path)
    parser.add_argument('--capture')
    parser.add_argument('--system-output', action='store_true')
    parser.add_argument('--microphone', action='store_true')
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--test-wav', type=Path)
    args = parser.parse_args()
    if args.system_output and args.microphone:
        raise ValueError('请选择一种音频输入。')
    if not (args.check or args.test_wav) and not (args.system_output or args.microphone):
        raise ValueError('请先明确同意采集默认扬声器的混合声音。')
    import numpy as np
    recognizer, vad = load_models(args.model_directory)
    if args.check:
        emit({'type': 'check', 'ok': True, 'engine': 'sensevoice'})
        return
    if args.test_wav:
        import wave
        with wave.open(str(args.test_wav), 'rb') as audio:
            if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (1, 2, 16000):
                raise ValueError('测试文件需为 16 kHz 单声道 PCM16 WAV。')
            samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype='<i2').astype(np.float32) / 32768
        # Exercise the same VAD and utterance decoding used by live capture.
        for offset in range(0, len(samples), 512):
            block = samples[offset:offset + 512]
            vad.accept_waveform(np.pad(block, (0, 512 - len(block))))
            if drain_segments(recognizer, vad, args.microphone):
                return
        vad.flush()
        drain_segments(recognizer, vad, args.microphone)
        return
    stopped = threading.Event()
    parent_closed = threading.Event()
    events = queue.Queue(maxsize=256)
    child = subprocess.Popen([args.capture, '--microphone' if args.microphone else '--system-output', '--pcm-output'],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))

    def close_parent():
        for _ in sys.stdin.buffer:
            pass
        parent_closed.set()
        stopped.set()
        try:
            child.stdin.close()
        except OSError:
            pass

    def read_capture():
        try:
            for raw in child.stdout:
                if stopped.is_set():
                    break
                try:
                    events.put(json.loads(raw), timeout=1)
                except queue.Full:
                    emit({'type': 'error', 'message': 'SenseVoice 处理速度不足，请停止字幕后改用系统识别。'})
                    break
        except (ValueError, OSError):
            emit({'type': 'error', 'message': '音频采集返回了无效数据。'})
        finally:
            stopped.set()

    threading.Thread(target=close_parent, daemon=True).start()
    threading.Thread(target=read_capture, daemon=True).start()
    pending = np.empty(0, dtype=np.float32)
    try:
        while not stopped.is_set() or not events.empty():
            try:
                event = events.get(timeout=0.2)
            except queue.Empty:
                continue
            if event.get('type') != 'pcm':
                if event.get('type') == 'ready':
                    event['message'] = 'SenseVoice 正在监听麦克风，说完后自动发送。' if args.microphone else 'SenseVoice 本机识别已就绪，停顿后显示字幕；采集默认扬声器混合声音。'
                emit(event)
                continue
            raw = base64.b64decode(event['data'], validate=True)
            if len(raw) > 64000 or len(raw) % 2:
                raise ValueError('无效的 PCM 数据。')
            samples = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768
            pending = np.concatenate((pending, samples))
            while len(pending) >= 512:
                vad.accept_waveform(pending[:512])
                pending = pending[512:]
                if drain_segments(recognizer, vad, args.microphone):
                    return
        if not parent_closed.is_set():
            raise RuntimeError('音频采集已中断。')
    finally:
        child.stdin.close()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        emit({'type': 'error', 'message': 'SenseVoice 启动或识别失败：' + str(error)})
        sys.exit(1)
