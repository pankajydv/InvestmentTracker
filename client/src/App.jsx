import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { PortfolioProvider } from './context/PortfolioContext';
import Navbar from './components/Navbar';
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

import Portfolios from './components/Portfolios';

export default function App() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <PortfolioProvider>
        <div style={{ minHeight: '100vh', backgroundColor: '#f8f9fa' }}>
          <Navbar />
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
        </div>
      </PortfolioProvider>
    </BrowserRouter>
  );
}
