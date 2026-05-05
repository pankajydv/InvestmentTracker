import React, { useEffect, useRef, useState } from 'react';
import { Card, Container, Alert, Spinner } from 'react-bootstrap';
import { TrendingUp } from 'lucide-react';

function ensureGoogleScript() {
  if (window.google && window.google.accounts && window.google.accounts.id) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const existing = document.getElementById('google-identity-script');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Failed to load Google Identity script')));
      return;
    }

    const script = document.createElement('script');
    script.id = 'google-identity-script';
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google Identity script'));
    document.head.appendChild(script);
  });
}

export default function Login({ googleClientId, onGoogleCredential, loginError, authDisabled }) {
  const buttonRef = useRef(null);
  const [scriptError, setScriptError] = useState('');
  const [loadingButton, setLoadingButton] = useState(true);

  useEffect(() => {
    let mounted = true;

    async function initGoogleButton() {
      if (!googleClientId || authDisabled) {
        if (mounted) setLoadingButton(false);
        return;
      }

      try {
        await ensureGoogleScript();
        if (!mounted) return;

        window.google.accounts.id.initialize({
          client_id: googleClientId,
          callback: async (response) => {
            if (response && response.credential) {
              await onGoogleCredential(response.credential);
            }
          },
        });

        if (buttonRef.current) {
          buttonRef.current.innerHTML = '';
          window.google.accounts.id.renderButton(buttonRef.current, {
            theme: 'outline',
            size: 'large',
            shape: 'pill',
            width: 300,
            text: 'continue_with',
          });
        }

        setLoadingButton(false);
      } catch (e) {
        if (!mounted) return;
        setScriptError(e.message || 'Unable to initialize Google Sign-In');
        setLoadingButton(false);
      }
    }

    initGoogleButton();
    return () => {
      mounted = false;
    };
  }, [googleClientId, onGoogleCredential, authDisabled]);

  return (
    <Container className="py-5" style={{ maxWidth: 560 }}>
      <Card className="shadow-sm border-0">
        <Card.Body className="p-4 p-md-5 text-center">
          <div className="d-flex justify-content-center mb-3">
            <TrendingUp size={34} className="text-primary" />
          </div>
          <h1 className="h4 fw-bold mb-2">Investment Tracker</h1>
          <p className="text-muted mb-4">Sign in with your approved Google account to continue.</p>

          {authDisabled && (
            <Alert variant="warning" className="text-start">
              Auth is currently disabled. Set <strong>GOOGLE_CLIENT_ID</strong> and keep
              <strong> AUTH_DISABLED</strong> unset (or false) to enable login enforcement.
            </Alert>
          )}

          {!authDisabled && !googleClientId && (
            <Alert variant="warning" className="text-start">
              Google Sign-In is not configured yet. The backend did not provide a
              <strong> GOOGLE_CLIENT_ID</strong>. Set env vars and restart the server.
            </Alert>
          )}

          {!authDisabled && (
            <>
              <div className="d-flex justify-content-center mb-3">
                <div ref={buttonRef} />
              </div>

              {loadingButton && (
                <div className="d-flex justify-content-center align-items-center gap-2 mb-3">
                  <Spinner size="sm" />
                  <span className="small text-muted">Loading Google Sign-In...</span>
                </div>
              )}

              {scriptError && <Alert variant="danger" className="text-start">{scriptError}</Alert>}
              {loginError && <Alert variant="danger" className="text-start">{loginError}</Alert>}
            </>
          )}
        </Card.Body>
      </Card>
    </Container>
  );
}
