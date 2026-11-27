using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Speech.AudioFormat;
using System.Speech.Recognition;
using System.Speech.Synthesis;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Windows 10 compatible endpoint loopback. This captures the DEFAULT SPEAKER
// MIX, not an individual application. The UI and launch flag require opt-in.
static class WindowsDoubaoCaptions {
    static readonly object outputLock = new object();
    static readonly ManualResetEvent done = new ManualResetEvent(false);
    static long lastSound;
    static int failed;
    public static void Emit(object value) {
        lock (outputLock) { Console.WriteLine(new JavaScriptSerializer().Serialize(value)); Console.Out.Flush(); }
    }
    static void Error(Exception error) {
        if (Interlocked.Exchange(ref failed, 1) == 0)
            Emit(new { type = "error", message = "Windows 通话字幕失败：" + error.Message });
        done.Set();
    }
    static RecognizerInfo Preferred() {
        var all = SpeechRecognitionEngine.InstalledRecognizers();
        var info = all.FirstOrDefault(x => x.Culture.Name == "zh-CN")
            ?? all.FirstOrDefault(x => x.Culture.Name == CultureInfo.CurrentUICulture.Name) ?? all.FirstOrDefault();
        if (info == null) throw new InvalidOperationException("请在 Windows 语言选项安装本机语音识别组件。");
        return info;
    }
    static SpeechRecognitionEngine Recognizer(RecognizerInfo info) {
        var engine = new SpeechRecognitionEngine(info.Id);
        try {
            engine.LoadGrammar(new DictationGrammar());
            engine.EndSilenceTimeout = TimeSpan.FromMilliseconds(650);
            engine.EndSilenceTimeoutAmbiguous = TimeSpan.FromMilliseconds(900);
            return engine;
        } catch { engine.Dispose(); throw; }
    }
    static int Main(string[] args) {
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Contains("--self-test")) return PcmConverter.SelfTest();
        try {
            if (args.Contains("--pcm-output")) {
                bool microphoneInput = args.Contains("--microphone");
                if (!args.Contains("--system-output") && !microphoneInput) throw new InvalidOperationException("请先明确同意采集默认扬声器的混合声音。");
                if (args.Contains("--system-output") && microphoneInput) throw new InvalidOperationException("请选择一种音频输入。");
                if (args.Contains("--listen")) throw new InvalidOperationException("SenseVoice 字幕暂不支持麦克风动作监听。");
                var parent = new Thread(() => { while (Console.ReadLine() != null) {} done.Set(); });
                parent.IsBackground = true; parent.Start();
                using (var pcm = new PcmStream(bytes => Emit(new { type = "pcm", data = Convert.ToBase64String(bytes) })))
                    Capture(pcm, "SenseVoice", microphoneInput);
                return 0;
            }
            var info = Preferred();
            if (args.Contains("--recognition-test")) return RecognitionTest(info);
            if (args.Contains("--probe")) {
                Emit(new { type = "probe", scope = "default-output-mix", language = info.Culture.Name });
                return 0;
            }
            if (!args.Contains("--system-output")) throw new InvalidOperationException("请先明确同意采集默认扬声器的混合声音。");
            Emit(new { type = "loading", message = "正在启动 Windows 扬声器转写（所有播放声音，本机识别，不保存录音）…" });
            // Parent pipe closure always releases capture, including a crashed VA.
            var lifetime = new Thread(() => { while (Console.ReadLine() != null) {} done.Set(); });
            lifetime.IsBackground = true; lifetime.Start();
            using (var stream = new PcmStream())
            using (var engine = Recognizer(info)) {
                engine.SetInputToAudioStream(stream, new SpeechAudioFormatInfo(16000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
                engine.SpeechHypothesized += (s, e) => Emit(new { type = "caption", text = e.Result.Text, final = false });
                engine.SpeechRecognized += (s, e) => {
                    if (!String.IsNullOrWhiteSpace(e.Result.Text)) Emit(new { type = "caption", text = e.Result.Text, final = true });
                };
                engine.RecognizeCompleted += (s, e) => { if (!done.WaitOne(0)) Error(e.Error ?? new Exception("本机识别意外结束，请重新开始字幕。")); };
                SpeechRecognitionEngine microphone = null;
                try {
                    if (args.Contains("--listen")) {
                        try {
                            microphone = Recognizer(info);
                            microphone.SetInputToDefaultAudioDevice();
                            microphone.SpeechRecognized += (s, e) => {
                                // Suppress loudspeaker echo; microphone is only used
                                // for local action requests, never sent to Doubao.
                                if (DateTime.UtcNow.Ticks - Interlocked.Read(ref lastSound) > TimeSpan.FromMilliseconds(1200).Ticks)
                                    Emit(new { type = "user-input", text = e.Result.Text });
                            };
                            microphone.RecognizeAsync(RecognizeMode.Multiple);
                            Emit(new { type = "mic-status", message = "正在识别本机麦克风动作请求；扬声器出声时暂停处理，建议戴耳机。" });
                        } catch (Exception error) {
                            if (microphone != null) { microphone.Dispose(); microphone = null; }
                            Emit(new { type = "mic-status", message = "麦克风未开启：" + error.Message + " 请检查 Windows 麦克风隐私和输入设备。" });
                        }
                    }
                    engine.RecognizeAsync(RecognizeMode.Multiple);
                    var capture = new Thread(() => {
                        try { Capture(stream, info.Culture.Name); } catch (Exception error) { Error(error); }
                        finally { stream.Finish(); }
                    });
                    capture.IsBackground = true; capture.SetApartmentState(ApartmentState.MTA); capture.Start();
                    done.WaitOne();
                    stream.Finish();
                    capture.Join(3000);
                } finally {
                    if (microphone != null) { microphone.RecognizeAsyncCancel(); microphone.Dispose(); }
                    engine.RecognizeAsyncCancel();
                }
            }
        } catch (Exception error) {
            if (args.Contains("--recognition-test")) Console.Error.WriteLine(error.ToString());
            Error(error);
        }
        return failed == 0 ? 0 : 1;
    }
    static void Check(int result) { Marshal.ThrowExceptionForHR(result); }
    // Offline diagnostic: synthesized PCM -> the same blocking input stream ->
    // installed recognizer. Does not open speakers, microphone, or loopback.
    static int RecognitionTest(RecognizerInfo info) {
        using (var synthesizer = new SpeechSynthesizer())
        using (var wave = new MemoryStream())
        using (var stream = new PcmStream())
        using (var recognizer = Recognizer(info)) {
            synthesizer.SetOutputToAudioStream(wave, new SpeechAudioFormatInfo(16000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
            synthesizer.Speak(info.Culture.Name == "zh-CN" ? "你好，这是一条语音字幕测试消息。" : "Hello, this is a voice caption test.");
            synthesizer.SetOutputToNull();
            var pcm = wave.ToArray();
            int start = 0, length = pcm.Length;
            if (pcm.Length > 12 && Encoding.ASCII.GetString(pcm, 0, 4) == "RIFF") {
                start = -1;
                for (int p = 12; p + 8 <= pcm.Length; ) {
                    int n = BitConverter.ToInt32(pcm, p + 4);
                    if (n < 0 || n > pcm.Length - p - 8) break;
                    if (Encoding.ASCII.GetString(pcm, p, 4) == "data") { start = p + 8; length = n; break; }
                    p += 8 + n + (n % 2);
                }
                if (start < 0) throw new IOException("测试 PCM 缺少音频数据。");
            }
            var audio = new byte[length]; Buffer.BlockCopy(pcm, start, audio, 0, length);
            stream.Add(audio); stream.Add(new byte[32000]); stream.Finish();
            recognizer.SetInputToAudioStream(stream, new SpeechAudioFormatInfo(16000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
            var result = recognizer.Recognize(TimeSpan.FromSeconds(15));
            Emit(new { type = "recognition-test", ok = result != null, text = result == null ? "" : result.Text, language = info.Culture.Name });
            return result != null ? 0 : 1;
        }
    }
    static void Release(object value) { if (value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value); }
    static void Capture(PcmStream stream, string language, bool microphoneInput = false) {
        IMMDeviceEnumerator enumerator = null; IMMDevice device = null;
        IAudioClient client = null; IAudioCaptureClient capture = null; IntPtr format = IntPtr.Zero;
        try {
            enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            // eRender / eMultimedia: follows the default playback device at start.
            Check(enumerator.GetDefaultAudioEndpoint(microphoneInput ? 1 : 0, 1, out device));
            var clientId = typeof(IAudioClient).GUID; object obj;
            Check(device.Activate(ref clientId, 23, IntPtr.Zero, out obj)); client = (IAudioClient)obj;
            Check(client.GetMixFormat(out format));
            var converter = new PcmConverter(format);
            Check(client.Initialize(0, microphoneInput ? 0u : 0x00020000u, 1000000, 0, format, IntPtr.Zero));
            var captureId = typeof(IAudioCaptureClient).GUID;
            Check(client.GetService(ref captureId, out obj)); capture = (IAudioCaptureClient)obj;
            Check(client.Start());
            Emit(new { type = "ready", actions = false, message = microphoneInput ? "正在监听默认麦克风（SenseVoice），说完后会自动发送。"
                : "正在监听默认扬声器的所有声音（" + language + "）；请在豆包播放声音，切换输出设备后需重新开始。" });
            bool heard = false; var lastLevel = DateTime.UtcNow; var lastPacket = DateTime.UtcNow;
            double levelPeak = 0;
            while (!done.WaitOne(10)) {
                uint size; Check(capture.GetNextPacketSize(out size));
                double peak = 0;
                while (size > 0) {
                    lastPacket = DateTime.UtcNow;
                    IntPtr data; uint frames, flags; ulong position, clock;
                    Check(capture.GetBuffer(out data, out frames, out flags, out position, out clock));
                    try { peak = Math.Max(peak, converter.Push(data, frames, (flags & 2) != 0, stream)); }
                    finally { Check(capture.ReleaseBuffer(frames)); }
                    Check(capture.GetNextPacketSize(out size));
                }
                // No loopback packets are delivered while the endpoint is idle.
                // Feed real-time silence so recognition can finalize the last phrase.
                if (!converter.HadPacket && (DateTime.UtcNow - lastPacket).TotalMilliseconds > 150) stream.Add(new byte[320]);
                converter.HadPacket = false;
                if (peak > .008) {
                    Interlocked.Exchange(ref lastSound, DateTime.UtcNow.Ticks);
                    if (!heard) { heard = true; Emit(new { type = "audio" }); }
                }
                levelPeak = Math.Max(levelPeak, peak);
                if ((DateTime.UtcNow - lastLevel).TotalMilliseconds >= 60) {
                    Emit(new { type = "level", value = Math.Min(.95, levelPeak * 3) }); lastLevel = DateTime.UtcNow; levelPeak = 0;
                }
            }
            client.Stop();
        } finally {
            if (format != IntPtr.Zero) Marshal.FreeCoTaskMem(format);
            Release(capture); Release(client); Release(device); Release(enumerator);
        }
    }
}

// Bounded in-memory PCM only. No file output or audio upload exists in this helper.
sealed class PcmStream : Stream {
    readonly Action<byte[]> onPcm;
    public PcmStream(Action<byte[]> onPcm = null) { this.onPcm = onPcm; }
    readonly Queue<byte[]> buffers = new Queue<byte[]>(); readonly object gate = new object();
    int offset, queued; long position; bool finished;
    public void Add(byte[] bytes) {
        if (bytes.Length == 0) return;
        if (onPcm != null) { onPcm(bytes); return; }
        lock (gate) {
            if (finished) return;
            if (queued + bytes.Length > 16000 * 2 * 15) throw new IOException("本机转写处理过慢，请停止后重试。");
            buffers.Enqueue(bytes); queued += bytes.Length; Monitor.PulseAll(gate);
        }
    }
    public void Finish() { lock (gate) { finished = true; Monitor.PulseAll(gate); } }
    public override int Read(byte[] buffer, int start, int count) {
        if (count == 0) return 0;
        lock (gate) {
            int read = 0;
            while (read < count) {
                while (buffers.Count == 0 && !finished) Monitor.Wait(gate);
                if (buffers.Count == 0) break;
                var next = buffers.Peek(); int length = Math.Min(count - read, next.Length - offset);
                Buffer.BlockCopy(next, offset, buffer, start + read, length);
                offset += length; queued -= length; position += length; read += length;
                if (offset == next.Length) { buffers.Dequeue(); offset = 0; }
            }
            return read;
        }
    }
    protected override void Dispose(bool disposing) { Finish(); base.Dispose(disposing); }
    public override bool CanRead { get { return true; } } public override bool CanSeek { get { return false; } }
    // SAPI queries Length even for a non-seekable input stream. The live input
    // has no known end; Read returns zero only after Finish/parent disconnect.
    public override bool CanWrite { get { return false; } } public override long Length { get { return Int64.MaxValue; } }
    public override long Position { get { return position; } set { throw new NotSupportedException(); } }
    public override void Flush() {}
    public override long Seek(long p, SeekOrigin o) {
        // SAPI uses Seek(0, Current) to query the cursor on live streams.
        if (p == 0 && o == SeekOrigin.Current || o == SeekOrigin.Begin && p == position) return position;
        throw new NotSupportedException("Live audio cannot be rewound.");
    }
    public override void SetLength(long n) { throw new NotSupportedException(); }
    public override void Write(byte[] b, int o, int n) { throw new NotSupportedException(); }
}

sealed class PcmConverter {
    readonly int channels, rate, bits, block; readonly bool floating;
    long phase; double sum; int samples;
    public bool HadPacket;
    public PcmConverter(IntPtr format) {
        int tag = (ushort)Marshal.ReadInt16(format, 0);
        channels = (ushort)Marshal.ReadInt16(format, 2); rate = Marshal.ReadInt32(format, 4);
        block = (ushort)Marshal.ReadInt16(format, 12); bits = (ushort)Marshal.ReadInt16(format, 14);
        if (tag == 0xfffe) {
            if ((ushort)Marshal.ReadInt16(format, 16) < 22) throw new IOException("无法读取扬声器音频格式。");
            var sub = (Guid)Marshal.PtrToStructure(IntPtr.Add(format, 24), typeof(Guid));
            if (sub == new Guid("00000003-0000-0010-8000-00aa00389b71")) tag = 3;
            else if (sub == new Guid("00000001-0000-0010-8000-00aa00389b71")) tag = 1;
        }
        floating = tag == 3;
        if (channels < 1 || channels > 32 || rate < 16000 || rate > 384000 || block != channels * bits / 8 ||
            !(floating && bits == 32 || tag == 1 && (bits == 16 || bits == 24 || bits == 32)))
            throw new IOException("扬声器格式暂不支持，请在 Windows 声音设置选择 PCM 16/24/32 位或浮点 32 位格式。");
    }
    public double Push(IntPtr pointer, uint frames, bool silent, PcmStream stream) {
        HadPacket = true;
        var data = new byte[checked((int)frames * block)];
        if (!silent) Marshal.Copy(pointer, data, 0, data.Length);
        var output = new List<byte>(); double peak = 0;
        for (int f = 0; f < frames; f++) {
            double value = 0;
            for (int c = 0; c < channels; c++) {
                int p = f * block + c * bits / 8; double sample;
                if (floating) sample = BitConverter.ToSingle(data, p);
                else if (bits == 16) sample = BitConverter.ToInt16(data, p) / 32768.0;
                else if (bits == 32) sample = BitConverter.ToInt32(data, p) / 2147483648.0;
                else sample = ((data[p] << 8) | (data[p + 1] << 16) | (data[p + 2] << 24)) / 2147483648.0;
                if (Double.IsNaN(sample) || Double.IsInfinity(sample)) sample = 0;
                value += sample / channels;
            }
            peak = Math.Max(peak, Math.Abs(value));
            // Box filter before downsampling, carrying phase across packet edges.
            sum += value; samples++; phase += 16000;
            if (phase >= rate) {
                short sample = (short)Math.Round(Math.Max(-1, Math.Min(1, sum / samples)) * 32767);
                output.Add((byte)(sample & 255)); output.Add((byte)(sample >> 8));
                phase -= rate; sum = 0; samples = 0;
            }
        }
        stream.Add(output.ToArray()); return peak;
    }
    public static int SelfTest() {
        IntPtr format = Marshal.AllocCoTaskMem(18), audio = Marshal.AllocCoTaskMem(480 * 8);
        try {
            var header = new byte[18]; Buffer.BlockCopy(BitConverter.GetBytes((short)3), 0, header, 0, 2);
            Buffer.BlockCopy(BitConverter.GetBytes((short)2), 0, header, 2, 2);
            Buffer.BlockCopy(BitConverter.GetBytes(48000), 0, header, 4, 4);
            Buffer.BlockCopy(BitConverter.GetBytes((short)8), 0, header, 12, 2);
            Buffer.BlockCopy(BitConverter.GetBytes((short)32), 0, header, 14, 2); Marshal.Copy(header, 0, format, 18);
            var data = new byte[480 * 8];
            for (int i = 0; i < 960; i++) Buffer.BlockCopy(BitConverter.GetBytes(.5f), 0, data, i * 4, 4);
            Marshal.Copy(data, 0, audio, data.Length);
            using (var stream = new PcmStream()) {
                var converter = new PcmConverter(format);
                double peak = converter.Push(audio, 479, false, stream);
                converter.Push(IntPtr.Add(audio, 479 * 8), 1, false, stream);
                converter.Push(IntPtr.Zero, 480, true, stream); stream.Finish();
                var output = new List<byte>(); var chunk = new byte[1024]; int n;
                while ((n = stream.Read(chunk, 0, chunk.Length)) > 0) output.AddRange(chunk.Take(n));
                var pcm = output.ToArray();
                if (pcm.Length != 640 || peak != .5 || BitConverter.ToInt16(pcm, 0) != 16384 || BitConverter.ToInt16(pcm, 320) != 0)
                    throw new Exception("PCM downmix/resample/silence test failed");
                WindowsDoubaoCaptions.Emit(new { type = "self-test", ok = true, frames = pcm.Length / 2 });
            }
            int emitted = 0;
            using (var stream = new PcmStream(bytes => emitted += bytes.Length)) {
                new PcmConverter(format).Push(audio, 480, false, stream);
                if (emitted != 320) throw new Exception("PCM streaming callback test failed");
            }
            return 0;
        } finally { Marshal.FreeCoTaskMem(format); Marshal.FreeCoTaskMem(audio); }
    }
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int flow, uint mask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr activation, [MarshalAs(UnmanagedType.IUnknown)] out object result);
}
[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient {
    [PreserveSig] int Initialize(int mode, uint flags, long duration, long periodicity, IntPtr format, IntPtr session);
    [PreserveSig] int GetBufferSize(out uint frames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint padding);
    [PreserveSig] int IsFormatSupported(int mode, IntPtr format, out IntPtr closest);
    [PreserveSig] int GetMixFormat(out IntPtr format);
    [PreserveSig] int GetDevicePeriod(out long period, out long minimum);
    [PreserveSig] int Start(); [PreserveSig] int Stop(); [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr handle);
    [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object result);
}
[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioCaptureClient {
    [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong position, out ulong clock);
    [PreserveSig] int ReleaseBuffer(uint frames);
    [PreserveSig] int GetNextPacketSize(out uint frames);
}
