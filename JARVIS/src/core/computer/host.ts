/**
 * Службы операционной системы, которые ядро получает снаружи (из Electron или из тестов).
 * Так ядро остаётся без зависимости от Electron, а опасные операции легко подменить в тестах.
 */
export interface HostServices {
  /** Переместить файл/папку в Корзину (не удалять навсегда). */
  trashItem?(path: string): Promise<void>;
  /** Открыть файл программой по умолчанию. Возвращает текст ошибки или ''. */
  openPath?(path: string): Promise<string>;
  /** Запустить программу из белого списка (без аргументов, без оболочки). */
  launchApp?(exePath: string): Promise<void>;
  /** Снимок экрана (основной монитор), JPEG в base64. */
  /** Кадр с веб-камеры (делается в окне приложения; только если пользователь включил камеру). */
  captureCamera?(): Promise<{ mime: string; base64: string; width: number; height: number }>;
  captureScreen?(): Promise<{ mime: string; base64: string; width: number; height: number }>;
}
