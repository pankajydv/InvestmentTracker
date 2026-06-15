import React from 'react';
import { Download } from 'lucide-react';
import { useInstallPrompt } from '../hooks/useInstallPrompt';

/**
 * PWA Install Button Component
 * Appears only when installation is available
 */
export function PWAInstallButton() {
  const { showInstallButton, handleInstall } = useInstallPrompt();

  if (!showInstallButton) return null;

  return (
    <button
      onClick={handleInstall}
      className="btn btn-sm btn-outline-primary d-flex align-items-center gap-2"
      title="Install Investment Tracker app on your device"
    >
      <Download size={16} />
      <span className="d-none d-sm-inline">Install App</span>
    </button>
  );
}
