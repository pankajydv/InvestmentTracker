import { useEffect } from 'react';

/**
 * Hook to register and manage the service worker
 */
export function useServiceWorker() {
  useEffect(() => {
    // Only register SW in production or if explicitly enabled
    const isDev = import.meta.env.MODE === 'development';
    const enableSWInDev = import.meta.env.VITE_ENABLE_SW_DEV === 'true';

    if (isDev && !enableSWInDev) {
      console.log('[PWA] Service Worker disabled in development (set VITE_ENABLE_SW_DEV=true to enable)');
      return;
    }

    // Check if SW is supported
    if (!('serviceWorker' in navigator)) {
      console.warn('[PWA] Service Worker not supported in this browser');
      return;
    }

    const registerServiceWorker = async () => {
      try {
        const registration = await navigator.serviceWorker.register('/serviceWorker.js', {
          scope: '/',
        });

        console.log('[PWA] Service Worker registered:', registration);

        // Listen for updates
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          console.log('[PWA] Service Worker update found');

          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              console.log('[PWA] New Service Worker available (refresh to update)');
              // Optionally: Show notification to user about update
              window.dispatchEvent(new CustomEvent('sw-update-available'));
            }
          });
        });
      } catch (error) {
        console.error('[PWA] Service Worker registration failed:', error);
      }
    };

    registerServiceWorker();
  }, []);
}
