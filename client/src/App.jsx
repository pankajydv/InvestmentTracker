import React, { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Spinner, Container, Alert } from 'react-bootstrap';
import { PortfolioProvider } from './context/PortfolioContext';
import Navbar from './components/Navbar';
import Login from './components/Login';
import Dashboard from './components/Dashboard';
import Investments from './components/Investments';
import InvestmentDetail from './components/InvestmentDetail';
import AddInvestment from './components/AddInvestment';
import CASUpload from './components/CASUpload';
import NPSUpload from './components/NPSUpload';
import Performance from './components/Performance';
import Transactions from './components/Transactions';
import CorporateActions from './components/CorporateActions';
import InvestmentSettings from './components/InvestmentSettings';
import InterestRates from './components/InterestRates';
import TaxReport from './components/TaxReport';
import BackToTopButton from './components/BackToTopButton';
import { getAuthConfig, getCurrentUser, loginWithGoogle, logout } from './services/api';

import Portfolios from './components/Portfolios';

export default function App() {
  const [bootLoading, setBootLoading] = useState(true);
  const [user, setUser] = useState(null);
  const [authDisabled, setAuthDisabled] = useState(false);
  const [googleClientId, setGoogleClientId] = useState('');
  const [loginError, setLoginError] = useState('');

  useEffect(() => {
    let mounted = true;

    async function bootstrap() {
      try {
        const cfg = await getAuthConfig();
        if (!mounted) return;
        setAuthDisabled(!!cfg.enabled === false);
        setGoogleClientId(cfg.googleClientId || '');

        const me = await getCurrentUser();
        if (!mounted) return;
        setUser(me.user || null);
      } catch (e) {
        if (!mounted) return;
        setUser(null);
      } finally {
        if (mounted) setBootLoading(false);
      }
    }

    bootstrap();
    return () => {
      mounted = false;
    };
  }, []);

  const handleGoogleCredential = useCallback(async (credential) => {
    try {
      setLoginError('');
      const data = await loginWithGoogle(credential);
      setUser(data.user || null);
    } catch (e) {
      setLoginError(e.message || 'Sign-in failed');
    }
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await logout();
    } catch (_) {
      // best effort
    }
    setUser(null);
  }, []);

  if (bootLoading) {
    return (
      <Container className="py-5 d-flex align-items-center justify-content-center gap-2">
        <Spinner size="sm" />
        <span className="text-muted">Loading app...</span>
      </Container>
    );
  }

  if (!user && !authDisabled) {
    return (
      <Login
        googleClientId={googleClientId}
        onGoogleCredential={handleGoogleCredential}
        loginError={loginError}
        authDisabled={authDisabled}
      />
    );
  }

  if (!user && authDisabled) {
    return (
      <Container className="py-4" style={{ maxWidth: 720 }}>
        <Alert variant="warning" className="mb-0">
          Auth is disabled and no session user is available. Refresh the page after server startup,
          or configure Google auth to continue.
        </Alert>
      </Container>
    );
  }

  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <PortfolioProvider>
        <div style={{ minHeight: '100vh', backgroundColor: '#f8f9fa' }}>
          <Navbar user={user} onLogout={handleLogout} />
          <main className="container py-4">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/investments" element={<Investments />} />
              <Route path="/investments/add" element={<AddInvestment />} />
              <Route path="/investments/import-cas" element={<CASUpload />} />
              <Route path="/investments/import-nps" element={<NPSUpload />} />
              <Route path="/investments/:id" element={<InvestmentDetail />} />
              <Route path="/investments/:id/settings" element={<InvestmentSettings />} />
              <Route path="/performance" element={<Performance />} />
              <Route path="/transactions" element={<Transactions />} />
              <Route path="/tax" element={<TaxReport />} />
              <Route path="/interest-rates" element={<InterestRates />} />
  
              <Route path="/portfolios" element={<Portfolios />} />
              <Route path="/corporate-actions" element={<CorporateActions />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
          <BackToTopButton />
        </div>
      </PortfolioProvider>
    </BrowserRouter>
  );
}
