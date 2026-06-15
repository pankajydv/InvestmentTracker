import { useState, useEffect } from 'react';

/**
 * Hook to detect and manage PWA install prompt
 * Returns install state and prompt handler
 */
export function useInstallPrompt() {
  const [installPrompt, setInstallPrompt] = useState(null);
  const [showInstallButton, setShowInstallButton] = useState(false);

  useEffect(() => {
    // Listen for beforeinstallprompt event
    const handleBeforeInstallPrompt = (event) => {
      // Prevent the mini-infobar from appearing
      event.preventDefault();
      // Store the event for later use
      setInstallPrompt(event);
      setShowInstallButton(true);
      console.log('[PWA] Install prompt available');
    };

    // Listen for app installed event
    const handleAppInstalled = () => {
      setInstallPrompt(null);
      setShowInstallButton(false);
      console.log('[PWA] App installed successfully');
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const handleInstall = async () => {
    if (!installPrompt) return;

    try {
      // Show the install prompt
      installPrompt.prompt();

      // Wait for user choice
      const { outcome } = await installPrompt.userChoice;
      console.log(`[PWA] User response: ${outcome}`);

      // Clear the install prompt
      setInstallPrompt(null);
      setShowInstallButton(false);
    } catch (error) {
      console.error('[PWA] Install failed:', error);
    }
  };

  return {
    showInstallButton,
    handleInstall,
  };
}
