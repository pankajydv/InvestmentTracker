import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { PortfolioProvider } from './context/PortfolioContext';
import Navbar from './components/Navbar';
import Dashboard from './components/Dashboard';
import Investments from './components/Investments';
import InvestmentDetail from './components/InvestmentDetail';
import AddInvestment from './components/AddInvestment';
import CASUpload from './components/CASUpload';
import Performance from './components/Performance';
import Transactions from './components/Transactions';

export default function App() {
  return (
    <BrowserRouter>
      <PortfolioProvider>
        <div className="min-h-screen bg-gray-50">
          <Navbar />
          <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/investments" element={<Investments />} />
              <Route path="/investments/add" element={<AddInvestment />} />
              <Route path="/investments/import-cas" element={<CASUpload />} />
              <Route path="/investments/:id" element={<InvestmentDetail />} />
              <Route path="/performance" element={<Performance />} />
              <Route path="/transactions" element={<Transactions />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
      </PortfolioProvider>
    </BrowserRouter>
  );
}
