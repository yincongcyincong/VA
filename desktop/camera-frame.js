window.capturePhoto = async () => {
  let stream;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  document.body.append(video);
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    video.srcObject = stream;
    await video.play();
    await new Promise(resolve => video.requestVideoFrameCallback(resolve));
    const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const mime = 'image/jpeg';
    const data = canvas.toDataURL(mime, 0.88).split(',')[1];
    return { mime, data, width: canvas.width, height: canvas.height };
  } catch (error) {
    return { cameraError: error.name };
  } finally {
    stream?.getTracks().forEach(track => track.stop());
    video.srcObject = null;
    video.remove();
  }
};
