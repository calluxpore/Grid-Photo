// Hidden worker window: detects faces and computes 128-d descriptors with
// @vladmandic/face-api (TensorFlow.js, WebGL backend).

import * as faceapi from '../vendor/face-api.esm.js';

const MAX_SIDE = 1280; // photos are downscaled to this for detection
const workCanvas = document.getElementById('work');
const thumbCanvas = document.getElementById('thumb');
let modelsLoaded = null;
const cancelled = new Set();

async function loadModels(url) {
  if (!modelsLoaded) {
    modelsLoaded = (async () => {
      try {
        await faceapi.tf.setBackend('webgl');
      } catch {
        await faceapi.tf.setBackend('cpu');
      }
      await faceapi.tf.ready();
      await faceapi.nets.ssdMobilenetv1.loadFromUri(url);
      await faceapi.nets.faceLandmark68Net.loadFromUri(url);
      await faceapi.nets.faceRecognitionNet.loadFromUri(url);
    })();
  }
  return modelsLoaded;
}

async function loadImage(path) {
  const res = await fetch(`gp://app/img?p=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  workCanvas.width = Math.max(1, Math.round(bmp.width * k));
  workCanvas.height = Math.max(1, Math.round(bmp.height * k));
  const ctx = workCanvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0, workCanvas.width, workCanvas.height);
  bmp.close();
  return workCanvas;
}

function faceThumb(canvas, box) {
  const pad = 0.25;
  const size = Math.max(box.width, box.height) * (1 + pad * 2);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const ctx = thumbCanvas.getContext('2d');
  ctx.fillStyle = '#222';
  ctx.fillRect(0, 0, 72, 72);
  ctx.drawImage(canvas, cx - size / 2, cy - size / 2, size, size, 0, 0, 72, 72);
  return thumbCanvas.toDataURL('image/jpeg', 0.82);
}

async function processImage(path, minFace) {
  const canvas = await loadImage(path);
  const options = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5, maxResults: 60 });
  const results = await faceapi.detectAllFaces(canvas, options).withFaceLandmarks().withFaceDescriptors();
  const faces = [];
  for (const r of results) {
    const box = r.detection.box;
    if (Math.min(box.width, box.height) < minFace) continue; // too small to recognise reliably
    faces.push({
      score: Math.round(r.detection.score * 1000) / 1000,
      area: Math.round((box.width * box.height) / (canvas.width * canvas.height) * 1e4) / 1e4,
      box: {
        x: box.x / canvas.width, y: box.y / canvas.height,
        w: box.width / canvas.width, h: box.height / canvas.height,
      },
      descriptor: Array.from(r.descriptor, (v) => Math.round(v * 1e5) / 1e5),
      thumb: faceThumb(canvas, box),
    });
  }
  return faces;
}

window.faceBridge.onCancel((jobId) => cancelled.add(jobId));

window.faceBridge.onJob(async ({ jobId, paths, minFace, modelUrl }) => {
  try {
    await loadModels(modelUrl);
  } catch (err) {
    window.faceBridge.send({ type: 'error', jobId, message: `Could not load the face model: ${err.message || err}` });
    return;
  }
  for (const path of paths) {
    if (cancelled.has(jobId)) break;
    try {
      const faces = await processImage(path, minFace);
      window.faceBridge.send({ type: 'image', jobId, path, faces });
    } catch (err) {
      window.faceBridge.send({ type: 'image', jobId, path, faces: [], error: String(err.message || err) });
    }
  }
  cancelled.delete(jobId);
  window.faceBridge.send({ type: 'done', jobId });
});
