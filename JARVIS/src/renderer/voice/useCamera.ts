import { useCallback, useEffect, useRef, useState } from 'react';
import type { Settings } from '../../shared/types';

export interface CameraControl {
  active: boolean;
  /** Поток для превью (null, если камера выключена). */
  stream: MediaStream | null;
  toggle(): void;
  stop(): void;
}

const MAX_W = 768;

/**
 * Камера включается только пользователем (кнопка + главный выключатель в настройках).
 * Кадр снимается по запросу ассистента (инструмент camera_look) и только пока камера включена.
 */
export function useCamera(p: { settings: Settings; enableCamera(): Promise<boolean>; onError(m: string): void }): CameraControl {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pRef = useRef(p);
  pRef.current = p;

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setStream(null);
  }, []);

  const toggle = useCallback(() => {
    void (async () => {
      if (streamRef.current) return stop();
      const cur = pRef.current;
      if (!cur.settings.cameraEnabled && !(await cur.enableCamera())) return;
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false });
        streamRef.current = s;
        if (!videoRef.current) {
          const v = document.createElement('video');
          v.muted = true;
          v.playsInline = true;
          videoRef.current = v;
        }
        videoRef.current.srcObject = s;
        await videoRef.current.play().catch(() => {});
        setStream(s);
      } catch (e) {
        const name = e instanceof DOMException ? e.name : '';
        pRef.current.onError(
          name === 'NotFoundError'
            ? 'Камера не найдена.'
            : 'Нет доступа к камере. Проверьте выключатель камеры в настройках JARVIS и разрешение Windows (Параметры → Конфиденциальность → Камера).',
        );
      }
    })();
  }, [stop]);

  // Ответ на запросы кадров от ассистента
  useEffect(() => {
    return window.jarvis.camera.onCaptureRequest((id) => {
      void (async () => {
        const v = videoRef.current;
        if (!streamRef.current || !v || v.videoWidth === 0) return window.jarvis.camera.sendFrame(id, null);
        // даём автоэкспозиции мгновение, чтобы кадр не был тёмным
        await new Promise((r) => setTimeout(r, 150));
        const scale = Math.min(1, MAX_W / v.videoWidth);
        const c = document.createElement('canvas');
        c.width = Math.round(v.videoWidth * scale);
        c.height = Math.round(v.videoHeight * scale);
        c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
        const base64 = c.toDataURL('image/jpeg', 0.72).split(',')[1] ?? '';
        await window.jarvis.camera.sendFrame(id, { mime: 'image/jpeg', base64, width: c.width, height: c.height });
      })();
    });
  }, []);

  // Главный выключатель выключен — камера гаснет немедленно
  useEffect(() => {
    if (!p.settings.cameraEnabled) stop();
  }, [p.settings.cameraEnabled, stop]);
  useEffect(() => () => stop(), [stop]);

  return { active: stream !== null, stream, toggle, stop };
}
