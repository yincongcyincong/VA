import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit
import SoundAnalysis

final class AudioMonitor: NSObject, SCStreamOutput, SCStreamDelegate, SNResultsObserving {
    private var analyzer: SNAudioStreamAnalyzer?
    private var analyzerFormat: AVAudioFormat?
    private var framePosition: AVAudioFramePosition = 0

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sample.isValid, sample.numSamples > 0,
              let description = sample.formatDescription,
              let basic = CMAudioFormatDescriptionGetStreamBasicDescription(description),
              let format = AVAudioFormat(streamDescription: basic),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(sample.numSamples))
        else { return }
        buffer.frameLength = buffer.frameCapacity
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sample, at: 0, frameCount: Int32(sample.numSamples), into: buffer.mutableAudioBufferList
        ) == noErr else { return }

        if analyzerFormat != format {
            do {
                let input = SNAudioStreamAnalyzer(format: format)
                let request = try SNClassifySoundRequest(classifierIdentifier: .version1)
                request.overlapFactor = 0.5
                try input.add(request, withObserver: self)
                analyzerFormat = format
                analyzer = input
                framePosition = 0
            } catch {
                fail("无法启动系统音乐分类。")
            }
        }
        analyzer?.analyze(buffer, atAudioFramePosition: framePosition)
        framePosition += AVAudioFramePosition(buffer.frameLength)
    }

    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let classification = result as? SNClassificationResult else { return }
        let score = classification.classifications.filter { prediction in
            let label = prediction.identifier
            return label == "music" || label.hasSuffix("_music") || label.hasPrefix("music_")
        }.map(\.confidence).max() ?? 0
        emit(["type": "score", "music": score])
    }

    func request(_ request: SNRequest, didFailWithError error: Error) {
        fail("系统音乐分类中断。")
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fail("系统音频监听已中断。请检查录制权限或重新开启监听。")
    }
}

func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value) {
        FileHandle.standardOutput.write(data + Data([10]))
    }
}

func fail(_ message: String) -> Never {
    emit(["type": "error", "message": message])
    exit(1)
}

@main
struct Main {
    static func main() async {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
                fail("无法找到可监听系统音频的显示器。")
            }
            let parent = CommandLine.arguments.dropFirst().first.flatMap(Int32.init)
            let excluded = content.applications.filter {
                $0.processID == parent || $0.bundleIdentifier == "local.va.desktop"
            }
            let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
            let configuration = SCStreamConfiguration()
            configuration.capturesAudio = true
            configuration.excludesCurrentProcessAudio = true
            configuration.sampleRate = 48000
            configuration.channelCount = 1
            configuration.width = 16
            configuration.height = 16
            configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            let monitor = AudioMonitor()
            let stream = SCStream(filter: filter, configuration: configuration, delegate: monitor)
            try stream.addStreamOutput(monitor, type: .audio, sampleHandlerQueue: DispatchQueue(label: "va.audio.analysis"))
            try await stream.startCapture()
            defer { withExtendedLifetime((stream, monitor)) {} }
            emit(["type": "ready"])
            // Keep the audio-only stream alive until VA stops the helper.
            while true { try await Task.sleep(for: .seconds(3600)) }
        } catch {
            fail("无法监听系统音频。请允许 VA 的「屏幕与系统音频录制」权限，退出 VA 后重试。")
        }
    }
}
