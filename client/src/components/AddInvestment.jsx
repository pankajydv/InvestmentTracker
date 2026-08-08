import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Row, Col, Button, Form, Alert, Spinner, Collapse, Table } from 'react-bootstrap';
import { createInvestment, addTransaction, getInvestments, searchMutualFunds, searchStock, searchStockByName, previewContractNotes, importContractNotes, uploadPnLStatement, uploadCASPreview, importCASHoldings, importCAMSCASTransactions, previewNPSStatements, importNPSTransactions, previewPPFStatements, importPPFTransactions, previewPFStatements, importPFTransactions, addManualPFTransaction, previewRsuGrantDocuments, importRsuGrantSchedule, getUSDINRRate, previewFidelityTradeConfirmations, importFidelityTradeConfirmations } from '../services/api';
import { ASSET_TYPE_LABELS, ASSET_TYPE_FILTER_ORDER } from '../utils/formatters';
import { ArrowLeft, Search, CheckCircle, FileText, Upload, Receipt, AlertCircle, Loader2, ChevronDown, ChevronUp, Plus } from 'lucide-react';
import { usePortfolio } from '../context/PortfolioContext';

const ASSET_TYPES = ASSET_TYPE_FILTER_ORDER;
const STOCK_TXN_TYPES = ['BUY', 'SELL'];

export default function AddInvestment() {
  const navigate = useNavigate();
  const { portfolios, selectedId, refreshPortfolios } = usePortfolio();
  const [step, setStep] = useState(1);
  const [assetType, setAssetType] = useState('MUTUAL_FUND');
  const [portfolioId, setPortfolioId] = useState(selectedId || '');

  const [form, setForm] = useState({
    name: '',
    ticker_symbol: '',
    amfi_code: '',
    folio_number: '',
    account_number: '',
    interest_rate: '',
    currency: 'INR',
    notes: '',
  });
  const [txn, setTxn] = useState({
    transaction_type: 'BUY',
    transaction_date: new Date().toISOString().split('T')[0],
    units: '',
    price_per_unit: '',
    amount: '',
    fees: '0',
  });
  const [mfResults, setMfResults] = useState([]);
  const [mfSearch, setMfSearch] = useState('');
  const [searching, setSearching] = useState(false);
  const [mfTxnLabel, setMfTxnLabel] = useState('Buy');
  const [mfAmountMode, setMfAmountMode] = useState('rupees');
  const [mfBroker, setMfBroker] = useState('');
  const [mfNotes, setMfNotes] = useState('');
  const [stockInfo, setStockInfo] = useState(null);
  const [stockResults, setStockResults] = useState([]);
  const [stockQuery, setStockQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const rsuGrantFileRef = useRef(null);
  const [rsuGrantFiles, setRsuGrantFiles] = useState([]);
  const [rsuGrantPreview, setRsuGrantPreview] = useState(null);
  const [rsuParsing, setRsuParsing] = useState(false);
  const [rsuCreating, setRsuCreating] = useState(false);
  const [rsuIncludeFuture, setRsuIncludeFuture] = useState(false);
  const [rsuOverwriteExisting, setRsuOverwriteExisting] = useState(false);

  const fidelityFileRef = useRef(null);
  const [fidelityFiles, setFidelityFiles] = useState([]);
  const [fidelityPreview, setFidelityPreview] = useState(null);
  const [fidelityParsing, setFidelityParsing] = useState(false);
  const [fidelityImporting, setFidelityImporting] = useState(false);
  const [fidelityResult, setFidelityResult] = useState(null);

  // Manual stock transaction state (for Foreign Stocks)
  const [showManualStockTxn, setShowManualStockTxn] = useState(false);
  const [manualStockTxn, setManualStockTxn] = useState({
    transaction_type: 'BUY',
    transaction_date: new Date().toISOString().split('T')[0],
    units: '',
    price_per_unit: '',
    amount: '',
    fees: '0',
    broker: 'Fidelity',
    exchange_rate_used: '',
    usd_amount: '',
    notes: '',
  });
  const [addingManualTxn, setAddingManualTxn] = useState(false);
  const [rateLoading, setRateLoading] = useState(false);

  // Contract notes upload state
  const contractFileRef = useRef(null);
  const [contractFiles, setContractFiles] = useState([]);
  const [contractUploading, setContractUploading] = useState(false);
  const [contractResult, setContractResult] = useState(null);
  const [contractPreview, setContractPreview] = useState(null); // preview data from server
  const [contractImporting, setContractImporting] = useState(false);

  // P&L upload state
  const pnlFileRef = useRef(null);
  const [pnlFile, setPnlFile] = useState(null);
  const [pnlBroker, setPnlBroker] = useState('');
  const [pnlUploading, setPnlUploading] = useState(false);
  const [pnlResult, setPnlResult] = useState(null);

  // CAS upload state (for Mutual Funds accordion)
  const casFileRef = useRef(null);
  const [casFile, setCasFile] = useState(null);
  const [casUploading, setCasUploading] = useState(false);
  const [casImporting, setCasImporting] = useState(false);
  const [casError, setCasError] = useState('');
  const [casPreview, setCasPreview] = useState(null);
  const [casResult, setCasResult] = useState(null);
  const [casSelectedMFs, setCasSelectedMFs] = useState(new Set());
  const [casShowMFs, setCasShowMFs] = useState(true);
  const [casPassword, setCasPassword] = useState('');
  // CAMS CAS specific state
  const [casSelectedSchemes, setCasSelectedSchemes] = useState(new Set());
  const [casExpandedScheme, setCasExpandedScheme] = useState(null);

  // Accordion state for Indian Stocks sections (null = all collapsed)
  const [expandedSection, setExpandedSection] = useState(null);
  const toggleSection = (key) => setExpandedSection(prev => prev === key ? null : key);

  // NPS state
  const npsFileRef = useRef(null);
  const npsPayslipRef = useRef(null);
  const [npsFiles, setNpsFiles] = useState([]);
  const [npsPayslipFiles, setNpsPayslipFiles] = useState([]);
  const [npsUploading, setNpsUploading] = useState(false);
  const [npsImporting, setNpsImporting] = useState(false);
  const [npsError, setNpsError] = useState('');
  const [npsPreview, setNpsPreview] = useState(null);
  const [npsResult, setNpsResult] = useState(null);
  const [npsSelectedSchemes, setNpsSelectedSchemes] = useState(new Set());
  const [npsExpandedScheme, setNpsExpandedScheme] = useState(null);
  const [npsPassword, setNpsPassword] = useState('');
  const [npsForm, setNpsForm] = useState({ name: '', account_number: '', notes: '' });
  const [npsTxn, setNpsTxn] = useState({
    transaction_type: 'BUY',
    transaction_date: new Date().toISOString().split('T')[0],
    units: '', price_per_unit: '', amount: '', fees: '0',
    source: 'Employer',
  });

  // PPF/SSY existing accounts state
  const [ppfAccounts, setPpfAccounts] = useState([]);
  const [selectedPpfAccount, setSelectedPpfAccount] = useState(''); // '' = create new, or investment id

  // PPF/SSY upload state
  const ppfFileRef = useRef(null);
  const [ppfFiles, setPpfFiles] = useState([]);
  const [ppfUploading, setPpfUploading] = useState(false);
  const [ppfImporting, setPpfImporting] = useState(false);
  const [ppfError, setPpfError] = useState('');
  const [ppfPreview, setPpfPreview] = useState(null);
  const [ppfResult, setPpfResult] = useState(null);
  const [ppfPassword, setPpfPassword] = useState('');
  const [ppfShowTxns, setPpfShowTxns] = useState(false);

  // PF/EPS upload state
  const pfFileRef = useRef(null);
  const [pfFiles, setPfFiles] = useState([]);
  const [pfUploading, setPfUploading] = useState(false);
  const [pfImporting, setPfImporting] = useState(false);
  const [pfError, setPfError] = useState('');
  const [pfPreview, setPfPreview] = useState(null);
  const [pfResult, setPfResult] = useState(null);
  const [pfShowTxns, setPfShowTxns] = useState(false);
  const [pfSelectedTxns, setPfSelectedTxns] = useState(new Set()); // For select/deselect individual transactions

  // PF manual entry form
  const [pfManualForm, setPfManualForm] = useState({
    date: new Date().toISOString().split('T')[0],
    type: 'DEPOSIT',
    amount: '',
    notes: '',
  });

  // Sync local portfolioId when navbar portfolio changes
  useEffect(() => {
    setPortfolioId(selectedId || '');
    setError('');
    setContractPreview(null);
  }, [selectedId]);

  // Fetch existing PPF/SSY accounts when asset type changes
  useEffect(() => {
    if (assetType === 'PPF' || assetType === 'SSY') {
      getInvestments(assetType).then(data => {
        setPpfAccounts(data || []);
        setSelectedPpfAccount('');
      }).catch(() => setPpfAccounts([]));
    }
  }, [assetType]);

  useEffect(() => {
    if (assetType === 'PPF' || assetType === 'SSY') {
      const allowedTypes = new Set(['DEPOSIT', 'WITHDRAWAL', 'INTEREST', 'RECONCILE']);
      setTxn((prev) => ({
        ...prev,
        transaction_type: allowedTypes.has(prev.transaction_type) ? prev.transaction_type : 'DEPOSIT',
      }));
    }
  }, [assetType]);

  const updateTxn = (field, value) => {
    const updated = { ...txn, [field]: value };
    if ((field === 'units' || field === 'price_per_unit') && updated.units && updated.price_per_unit) {
      updated.amount = (parseFloat(updated.units) * parseFloat(updated.price_per_unit)).toFixed(2);
    }
    setTxn(updated);
  };

  const PF_MANUAL_TYPES = [
    { value: 'DEPOSIT', label: 'Employee Contribution', amountLabel: 'Employee contribution' },
    { value: 'EMPLOYER_CONTRIBUTION', label: 'Employer Contribution', amountLabel: 'Employer contribution' },
    { value: 'VOLUNTARY_CONTRIBUTION', label: 'Voluntary Contribution', amountLabel: 'Voluntary contribution' },
    { value: 'INTEREST', label: 'Interest', amountLabel: 'Interest amount' },
    { value: 'WITHDRAWAL', label: 'Withdrawal', amountLabel: 'Withdrawal amount' },
    { value: 'RECONCILE', label: 'Reconcile', amountLabel: 'Reconcile amount' },
  ];

  const pfManualTypeMeta = PF_MANUAL_TYPES.find((item) => item.value === pfManualForm.type) || PF_MANUAL_TYPES[0];

  const handleMfSearch = async () => {
    if (mfSearch.length < 2) return;
    setSearching(true);
    try {
      const results = await searchMutualFunds(mfSearch);
      setMfResults(results);
    } catch (e) {
      console.error(e);
    } finally {
      setSearching(false);
    }
  };

  const selectMf = (mf) => {
    setForm({ ...form, name: mf.schemeName, amfi_code: mf.schemeCode });
    setMfResults([]);
    setMfSearch(mf.schemeName);
  };

  const handleStockSearch = async () => {
    if (!stockQuery || stockQuery.length < 2) return;
    setSearching(true);
    setStockInfo(null);
    setStockResults([]);
    setError('');
    try {
      const market = assetType === 'INDIAN_STOCK' ? 'NSE' : '';
      const results = await searchStockByName(stockQuery, market);
      if (results.length === 0) {
        setError(`No stocks found for: ${stockQuery}`);
      } else {
        setStockResults(results);
      }
    } catch (e) {
      setError(`Search failed: ${e.message}`);
    } finally {
      setSearching(false);
    }
  };

  const selectStock = async (result) => {
    setStockResults([]);
    setSearching(true);
    try {
      const data = await searchStock(result.symbol, '');
      setStockInfo(data);
      setForm({ ...form, name: data.name, ticker_symbol: result.symbol, currency: data.currency === 'USD' ? 'USD' : 'INR' });
      setStockQuery(result.name);
    } catch (e) {
      setError(`Could not fetch price for ${result.symbol}`);
    } finally {
      setSearching(false);
    }
  };

  const handleRsuGrantPreview = async () => {
    setError('');
    if (!rsuGrantFiles.length) {
      setError('Please upload stock grant document files first');
      return;
    }

    setRsuParsing(true);
    try {
      const preview = await previewRsuGrantDocuments(rsuGrantFiles);
      if (!preview.grant_keys || preview.grant_keys.length === 0) {
        setError('Could not map uploaded files to known grants. Check document format or file selection.');
      }
      setRsuGrantPreview(preview);
    } catch (e) {
      setError(e.message);
    } finally {
      setRsuParsing(false);
    }
  };

  const handleCreateFromRsuDocs = async () => {
    setError('');
    if (!portfolioId) {
      setError('Please select a portfolio first (top navbar selector)');
      return;
    }
    if (!rsuGrantPreview?.grant_keys?.length) {
      setError('Preview grant documents first to detect grant awards');
      return;
    }

    setRsuCreating(true);
    try {
      const investmentName = (form.name || stockInfo?.name || stockQuery || 'Microsoft Corp').trim();
      const ticker = (form.ticker_symbol || 'MSFT').trim().toUpperCase();
      const notesFromDocs = `Created from RSU grant docs (${rsuGrantPreview.grant_keys.length} awards)`;

      // Safety: reuse an existing matching FOREIGN_STOCK investment when possible
      // to avoid unintentionally creating a duplicate and splitting RSU history.
      const existingMatches = (await getInvestments())
        .filter((inv) => String(inv.asset_type || '').toUpperCase() === 'FOREIGN_STOCK')
        .filter((inv) => String(inv.ticker_symbol || '').toUpperCase() === ticker);

      if (existingMatches.length > 1) {
        setError(`Found ${existingMatches.length} existing ${ticker} investments. To avoid importing into the wrong one, open the target investment and use the "RSU Grants" button there.`);
        return;
      }

      const inv = existingMatches.length === 1
        ? existingMatches[0]
        : await createInvestment({
          name: investmentName,
          asset_type: 'FOREIGN_STOCK',
          ticker_symbol: ticker,
          currency: 'USD',
          notes: form.notes || notesFromDocs,
        });

      await importRsuGrantSchedule({
        investment_id: inv.id,
        portfolio_id: Number(portfolioId),
        grant_keys: rsuGrantPreview.grant_keys,
        include_future: rsuIncludeFuture,
        overwrite_existing: rsuOverwriteExisting,
      });

      navigate(`/investments/${inv.id}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setRsuCreating(false);
    }
  };

  const handleRsuGrantReset = () => {
    setRsuGrantFiles([]);
    setRsuGrantPreview(null);
    setRsuIncludeFuture(false);
    setRsuOverwriteExisting(false);
    if (rsuGrantFileRef.current) rsuGrantFileRef.current.value = '';
  };

  const handleFidelityPreview = async () => {
    setError('');
    if (!portfolioId) return setError('Please select a portfolio first');
    if (!fidelityFiles.length) return setError('Please select at least one Fidelity confirmation PDF');
    setFidelityParsing(true);
    try {
      setFidelityPreview(await previewFidelityTradeConfirmations(fidelityFiles));
      setFidelityResult(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setFidelityParsing(false);
    }
  };

  const handleFidelityImport = async () => {
    if (!fidelityPreview?.trades?.length) return;
    setError('');
    setFidelityImporting(true);
    try {
      const result = await importFidelityTradeConfirmations(Number(portfolioId), fidelityPreview.trades);
      setFidelityResult(result);
      setFidelityPreview(null);
      await refreshPortfolios();
      navigate(`/investments/${result.investmentId}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setFidelityImporting(false);
    }
  };

  const handleFidelityReset = () => {
    setFidelityFiles([]);
    setFidelityPreview(null);
    setFidelityResult(null);
    if (fidelityFileRef.current) fidelityFileRef.current.value = '';
  };

  const updateManualStockTxn = (field, value) => {
    const updated = { ...manualStockTxn, [field]: value };
    if ((field === 'units' || field === 'price_per_unit') && updated.units && updated.price_per_unit) {
      updated.amount = (parseFloat(updated.units) * parseFloat(updated.price_per_unit)).toFixed(2);
    }
    setManualStockTxn(updated);
  };

  const handleFetchUSDINRRate = async () => {
    if (!manualStockTxn.transaction_date) return;
    setRateLoading(true);
    try {
      const rate = await getUSDINRRate(manualStockTxn.transaction_date);
      updateManualStockTxn('exchange_rate_used', rate);
    } catch (e) {
      alert('Failed to fetch USD/INR rate: ' + e.message);
    } finally {
      setRateLoading(false);
    }
  };

  const handleAddManualStockTxn = async () => {
    setError('');
    if (!form.name || !form.ticker_symbol) {
      setError('Please select a stock first');
      return;
    }
    if (!portfolioId) {
      setError('Please select a portfolio first');
      return;
    }
    if (!manualStockTxn.units || !manualStockTxn.price_per_unit || !manualStockTxn.transaction_date) {
      setError('Date, units, and price are required');
      return;
    }

    setAddingManualTxn(true);
    try {
      // Create investment first
      const inv = await createInvestment({
        name: form.name.trim(),
        asset_type: 'FOREIGN_STOCK',
        ticker_symbol: form.ticker_symbol.trim().toUpperCase(),
        currency: 'USD',
        notes: form.notes || '',
      });

      // Auto-fetch the FX rate for the transaction date
      let exchangeRate = null;
      try {
        exchangeRate = await getUSDINRRate(manualStockTxn.transaction_date);
      } catch (e) {
        console.warn('Could not fetch exchange rate:', e.message);
      }

      // Then add transaction to investment
      await addTransaction({
        investment_id: inv.id,
        portfolio_id: Number(portfolioId),
        transaction_type: manualStockTxn.transaction_type || 'BUY',
        transaction_date: manualStockTxn.transaction_date,
        units: parseFloat(manualStockTxn.units) || 0,
        price_per_unit: parseFloat(manualStockTxn.price_per_unit) || 0,
        amount: parseFloat(manualStockTxn.amount || 0),
        fees: parseFloat(manualStockTxn.fees || 0),
        broker: manualStockTxn.broker || 'Fidelity',
        exchange_rate_used: exchangeRate,
        notes: manualStockTxn.notes || '',
      });

      alert(`Investment ${inv.name} created. Now use the ESPP modal in the investment detail page to upload payslips.`);
      navigate(`/investments/${inv.id}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setAddingManualTxn(false);
    }
  };

  const handleCancelManualStockTxn = () => {
    setShowManualStockTxn(false);
    setManualStockTxn({
      transaction_type: 'BUY',
      transaction_date: new Date().toISOString().split('T')[0],
      units: '',
      price_per_unit: '',
      amount: '',
      fees: '0',
      broker: 'Fidelity',
      exchange_rate_used: '',
      usd_amount: '',
      notes: '',
    });
  };

  const handleContractUpload = async () => {
    setError('');
    if (!portfolioId) return setError('Please select a portfolio first');
    if (!contractFiles.length) return setError('Please select at least one contract note file');
    setContractUploading(true);
    try {
      const preview = await previewContractNotes(contractFiles, portfolioId);
      setContractPreview(preview);
    } catch (e) {
      setError(e.message);
    } finally {
      setContractUploading(false);
    }
  };

  const handleContractApprove = async () => {
    setError('');
    if (!contractPreview) return;
    setContractImporting(true);
    try {
      const result = await importContractNotes(
        portfolioId,
        contractPreview.broker,
        contractPreview.trades,
        contractPreview.intradayTrades || [],
      );
      setContractResult(result);
      setContractPreview(null);
      await refreshPortfolios();
    } catch (e) {
      setError(e.message);
    } finally {
      setContractImporting(false);
    }
  };

  const handleContractCancel = () => {
    setContractPreview(null);
    setContractFiles([]);
    if (contractFileRef.current) contractFileRef.current.value = '';
  };

  const updatePreviewTrade = (index, field, value) => {
    setContractPreview(prev => {
      const trades = [...prev.trades];
      trades[index] = { ...trades[index], [field]: value };
      // Recalculate total if quantity or rate changed
      if (field === 'quantity' || field === 'rate') {
        trades[index].total = (parseFloat(trades[index].quantity) || 0) * (parseFloat(trades[index].rate) || 0);
      }
      return { ...prev, trades };
    });
  };

  const removePreviewTrade = (index) => {
    setContractPreview(prev => ({
      ...prev,
      trades: prev.trades.filter((_, i) => i !== index),
    }));
  };

  // CAS upload handlers
  const casSelectedPortfolio = portfolios.find(p => p.id === Number(portfolioId));
  const formatCurrency = (v) => '₹' + Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

  const handleCASUpload = async () => {
    setCasError('');
    if (!portfolioId) return setCasError('Please select a portfolio first (from the top navbar)');
    if (!casFile) return setCasError('Please select a CAS PDF file');
    setCasUploading(true);
    try {
      const result = await uploadCASPreview(casFile, portfolioId, casPassword || undefined);
      setCasPreview(result);
      if (result.casType === 'cams') {
        // CAMS CAS — select schemes that have new OR updatable (STT/fees) transactions
        setCasSelectedSchemes(new Set(
          result.schemes
            .map((s, i) => ((s.newTransactionCount > 0 || s.updateTransactionCount > 0) ? i : null))
            .filter(i => i !== null)
        ));
      } else {
        // CDSL/NSDL CAS — MF holdings only
        setCasSelectedMFs(new Set(result.mutualFunds.filter(h => h.isNew).map((_, i) => i)));
      }
    } catch (e) {
      setCasError(e.message);
    } finally {
      setCasUploading(false);
    }
  };

  const handleCASImport = async () => {
    setCasError('');
    if (casPreview?.casType === 'cams') {
      // CAMS CAS — send ALL transactions for selected schemes so the server can
      // insert new ones AND correct STT/fees on already-existing transactions.
      const schemes = [];
      casSelectedSchemes.forEach(idx => {
        const s = casPreview.schemes[idx];
        if (!s) return;
        if (s.transactions && s.transactions.length > 0) {
          schemes.push({
            isin: s.isin,
            schemeName: s.schemeName,
            folio: s.folio,
            amc: s.amc,
            transactions: s.transactions,
          });
        }
      });
      if (schemes.length === 0) return setCasError('No transactions to import in selected schemes');
      setCasImporting(true);
      try {
        const result = await importCAMSCASTransactions(portfolioId, schemes);
        await refreshPortfolios();
        setCasResult(result);
        setCasPreview(null);
      } catch (e) {
        setCasError(e.message);
      } finally {
        setCasImporting(false);
      }
      return;
    }

    // CDSL/NSDL CAS — MF holdings only
    const holdings = [];
    casSelectedMFs.forEach(idx => { if (casPreview.mutualFunds[idx]) holdings.push(casPreview.mutualFunds[idx]); });
    if (holdings.length === 0) return setCasError('No mutual fund holdings selected for import');
    setCasImporting(true);
    try {
      const result = await importCASHoldings(portfolioId, holdings);
      await refreshPortfolios();
      setCasResult(result);
      setCasPreview(null);
    } catch (e) {
      setCasError(e.message);
    } finally {
      setCasImporting(false);
    }
  };

  const handleCASReset = () => {
    setCasPreview(null);
    setCasFile(null);
    setCasResult(null);
    setCasError('');
    setCasPassword('');
    setCasSelectedSchemes(new Set());
    setCasExpandedScheme(null);
    if (casFileRef.current) casFileRef.current.value = '';
  };

  const casTotalSelected = casSelectedMFs.size;

  // NPS upload handlers
  const handleNPSUpload = async () => {
    setNpsError('');
    if (!portfolioId) return setNpsError('Please select a portfolio first');
    if (!npsFiles.length) return setNpsError('Please select NPS statement files');
    setNpsUploading(true);
    try {
      const data = await previewNPSStatements(npsFiles, portfolioId, npsPassword, npsPayslipFiles);
      setNpsPreview(data);
      setNpsSelectedSchemes(new Set(
        data.schemes.map((s, i) => s.newTransactionCount > 0 ? i : null).filter(i => i !== null)
      ));
    } catch (e) {
      setNpsError(e.message);
    } finally {
      setNpsUploading(false);
    }
  };

  const handleNPSImport = async () => {
    setNpsError('');
    if (!npsPreview) return;
    const schemes = [];
    npsSelectedSchemes.forEach(idx => {
      const s = npsPreview.schemes[idx];
      if (!s) return;
      const newTxns = s.transactions.filter(t => t.isNew);
      if (newTxns.length > 0) {
        schemes.push({ schemeName: s.schemeName, transactions: newTxns });
      }
    });
    if (schemes.length === 0) return setNpsError('No new transactions to import');
    setNpsImporting(true);
    try {
      const res = await importNPSTransactions(portfolioId, npsPreview.pran, schemes);
      setNpsResult(res);
      setNpsPreview(null);
      await refreshPortfolios();
    } catch (e) {
      setNpsError(e.message);
    } finally {
      setNpsImporting(false);
    }
  };

  const handleNPSReset = () => {
    setNpsPreview(null);
    setNpsResult(null);
    setNpsFiles([]);
    setNpsPayslipFiles([]);
    setNpsError('');
    setNpsSelectedSchemes(new Set());
    setNpsExpandedScheme(null);
    setNpsPassword('');
    if (npsFileRef.current) npsFileRef.current.value = '';
    if (npsPayslipRef.current) npsPayslipRef.current.value = '';
  };

  const NPS_TXN_TYPES = [
    { value: 'EMPLOYER_CONTRIBUTION', label: 'Employer Contribution' },
    { value: 'VOLUNTARY_CONTRIBUTION', label: 'Voluntary Contribution' },
    { value: 'TRANSFER_IN', label: 'Transfer In' },
    { value: 'TRANSFER_OUT', label: 'Transfer Out' },
    { value: 'AMC', label: 'AMC Charges' },
    { value: 'CHARGES', label: 'Legacy Charges' },
  ];

  const NPS_SOURCES = [
    { value: 'Employer', label: 'Employer Contribution' },
    { value: 'Voluntary', label: 'Voluntary Contribution' },
    { value: 'Rebalancing', label: 'Rebalancing' },
    { value: '', label: 'Other' },
  ];

  const updateNpsTxn = (field, value) => {
    const updated = { ...npsTxn, [field]: value };
    if ((field === 'units' || field === 'price_per_unit') && updated.units && updated.price_per_unit) {
      updated.amount = (parseFloat(updated.units) * parseFloat(updated.price_per_unit)).toFixed(2);
    }
    setNpsTxn(updated);
  };

  const handleNPSManualSubmit = async () => {
    setError('');
    setSubmitting(true);
    try {
      if (!npsForm.name) { setError('Scheme name is required'); setSubmitting(false); return; }
      if (!npsTxn.amount || parseFloat(npsTxn.amount) <= 0) { setError('Amount is required'); setSubmitting(false); return; }

      const inv = await createInvestment({
        name: npsForm.name,
        asset_type: 'NPS',
        account_number: npsForm.account_number || null,
        currency: 'INR',
        notes: npsForm.notes || null,
      });

      await addTransaction({
        investment_id: inv.id,
        portfolio_id: portfolioId || null,
        transaction_type: npsTxn.transaction_type,
        transaction_date: npsTxn.transaction_date,
        units: npsTxn.units ? parseFloat(npsTxn.units) : null,
        price_per_unit: npsTxn.price_per_unit ? parseFloat(npsTxn.price_per_unit) : null,
        amount: parseFloat(npsTxn.amount),
        fees: parseFloat(npsTxn.fees) || 0,
        broker: npsTxn.source || null,
      });

      navigate(`/investments/${inv.id}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  // PPF/SSY upload handlers
  const handlePPFUpload = async () => {
    setPpfError('');
    if (!portfolioId) return setPpfError('Please select a portfolio first');
    if (!ppfFiles.length) return setPpfError('Please select PPF/SSY statement files');
    setPpfUploading(true);
    try {
      const data = await previewPPFStatements(ppfFiles, portfolioId, ppfPassword);
      setPpfPreview(data);
    } catch (e) {
      setPpfError(e.message);
    } finally {
      setPpfUploading(false);
    }
  };

  const handlePPFImport = async () => {
    setPpfError('');
    if (!ppfPreview) return;
    const newTxns = ppfPreview.transactions.filter(t => t.isNew);
    if (newTxns.length === 0) return setPpfError('No new transactions to import');
    setPpfImporting(true);
    try {
      const res = await importPPFTransactions(portfolioId, {
        accountName: ppfPreview.accountName,
        accountNumber: ppfPreview.accountNumber,
        accountType: ppfPreview.accountType,
        interestRate: ppfPreview.interestRate,
        openDate: ppfPreview.openDate,
        maturityDate: ppfPreview.maturityDate,
        openingBalance: ppfPreview.openingBalance || 0,
        transactions: newTxns,
      });
      setPpfResult(res);
      setPpfPreview(null);
      await refreshPortfolios();
    } catch (e) {
      setPpfError(e.message);
    } finally {
      setPpfImporting(false);
    }
  };

  const handlePPFReset = () => {
    setPpfPreview(null);
    setPpfResult(null);
    setPpfFiles([]);
    setPpfError('');
    setPpfPassword('');
    setPpfShowTxns(false);
    if (ppfFileRef.current) ppfFileRef.current.value = '';
  };

  const PPF_TYPE_COLORS = {
    DEPOSIT: 'bg-success', INTEREST: 'bg-info', WITHDRAWAL: 'bg-danger',
  };

  // PF Handlers
  const handlePFUpload = async () => {
    setPfError('');
    if (!portfolioId) return setPfError('Please select a portfolio first');
    if (!pfFiles.length) return setPfError('Please select PF statement PDF files');
    setPfUploading(true);
    try {
      const data = await previewPFStatements(pfFiles, portfolioId);
      setPfPreview(data);
    } catch (e) {
      setPfError(e.message);
    } finally {
      setPfUploading(false);
    }
  };

  const handlePFImport = async () => {
    setPfError('');
    if (!pfPreview) return;
    const selectedTxns = Array.from(pfSelectedTxns).map(idx => pfPreview.transactions[idx]);
    if (selectedTxns.length === 0) return setPfError('Please select transactions to import');
    setPfImporting(true);
    try {
      const res = await importPFTransactions(portfolioId, {
        pfInvestmentId: pfPreview.pfInvestmentId,
        uan: pfPreview.uan,
        transactions: selectedTxns,
      });
      setPfResult(res);
      setPfPreview(null);
      setPfSelectedTxns(new Set());
      await refreshPortfolios();
    } catch (e) {
      setPfError(e.message);
    } finally {
      setPfImporting(false);
    }
  };

  const handlePFReset = () => {
    setPfPreview(null);
    setPfResult(null);
    setPfFiles([]);
    setPfError('');
    setPfShowTxns(false);
    setPfSelectedTxns(new Set());
    if (pfFileRef.current) pfFileRef.current.value = '';
  };

  const togglePFTransaction = (idx) => {
    const newSet = new Set(pfSelectedTxns);
    if (newSet.has(idx)) {
      newSet.delete(idx);
    } else {
      newSet.add(idx);
    }
    setPfSelectedTxns(newSet);
  };

  const handlePFManualSubmit = async () => {
    setPfError('');
    if (!portfolioId) return setPfError('Please select a portfolio first');
    if (!pfManualForm.date) return setPfError('Please select a date');
    if (!pfManualForm.amount || parseFloat(pfManualForm.amount) <= 0) {
      return setPfError('Please enter an amount');
    }

    setPfImporting(true);
    try {
      const res = await addManualPFTransaction(portfolioId, {
        date: pfManualForm.date,
        type: pfManualForm.type,
        amount: parseFloat(pfManualForm.amount),
        notes: (pfManualForm.notes || '').trim(),
      });

      setPfResult(res);
      setPfManualForm({
        date: new Date().toISOString().split('T')[0],
        type: 'DEPOSIT',
        amount: '',
        notes: '',
      });
      await refreshPortfolios();
    } catch (e) {
      setPfError(e.message);
    } finally {
      setPfImporting(false);
    }
  };

  const PF_TYPE_COLORS = {
    DEPOSIT: 'bg-success',
    EMPLOYER_CONTRIBUTION: 'bg-info',
    EPS_CONTRIBUTION: 'bg-warning',
    INTEREST: 'bg-primary',
    WITHDRAWAL: 'bg-danger',
  };

  const handlePnlUpload = async () => {
    setError('');
    if (!portfolioId) return setError('Please select a portfolio first');
    if (!pnlFile) return setError('Please select a P&L statement file');
    if (!pnlBroker) return setError('Please select a broker');
    setPnlUploading(true);
    try {
      const result = await uploadPnLStatement(pnlFile, pnlBroker, portfolioId);
      setPnlResult(result);
      await refreshPortfolios();
    } catch (e) {
      setError(e.message);
    } finally {
      setPnlUploading(false);
    }
  };

  // Map MF UI labels to DB transaction types
  const MF_TXN_MAP = { Buy: 'BUY', Sell: 'SELL', SIP: 'BUY', SWP: 'SELL', STP: 'SELL', Switch: 'SELL' };

  const handleMfSubmit = async () => {
    setError('');
    setSubmitting(true);
    try {
      if (!form.name) { setError('Please search and select a scheme'); setSubmitting(false); return; }

      const units = txn.units ? parseFloat(txn.units) : null;
      const nav = txn.price_per_unit ? parseFloat(txn.price_per_unit) : null;
      let amount = txn.amount ? parseFloat(txn.amount) : null;

      // Auto-calculate based on mode
      if (mfAmountMode === 'units' && units && nav) {
        amount = units * nav;
      } else if (mfAmountMode === 'rupees' && amount && nav && !units) {
        // units will be calculated server-side or can be left null
      }

      const inv = await createInvestment({
        name: form.name,
        asset_type: 'MUTUAL_FUND',
        amfi_code: form.amfi_code || null,
        folio_number: form.folio_number || null,
        currency: 'INR',
      });

      if (amount && amount > 0) {
        await addTransaction({
          investment_id: inv.id,
          portfolio_id: portfolioId || null,
          transaction_type: MF_TXN_MAP[mfTxnLabel] || 'BUY',
          transaction_date: txn.transaction_date,
          units,
          price_per_unit: nav,
          amount,
          fees: 0,
          broker: mfBroker || null,
          notes: mfNotes || null,
        });
      }

      navigate(`/investments/${inv.id}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    setError('');
    setSubmitting(true);
    try {
      const isPpfSsy = assetType === 'PPF' || assetType === 'SSY';
      let invId;

      if (isPpfSsy && selectedPpfAccount) {
        // Adding transaction to existing account
        invId = parseInt(selectedPpfAccount);
      } else {
        if (!form.name) {
          setError('Name is required');
          setSubmitting(false);
          return;
        }
        const inv = await createInvestment({
          name: form.name,
          asset_type: assetType,
          ticker_symbol: form.ticker_symbol || null,
          amfi_code: form.amfi_code || null,
          folio_number: form.folio_number || null,
          account_number: form.account_number || null,
          interest_rate: form.interest_rate ? parseFloat(form.interest_rate) : null,
          currency: form.currency,
          notes: form.notes || null,
        });
        invId = inv.id;
      }

      if (txn.amount && parseFloat(txn.amount) > 0) {
        await addTransaction({
          investment_id: invId,
          portfolio_id: portfolioId || null,
          transaction_type: txn.transaction_type,
          transaction_date: txn.transaction_date,
          units: txn.units ? parseFloat(txn.units) : null,
          price_per_unit: txn.price_per_unit ? parseFloat(txn.price_per_unit) : null,
          amount: parseFloat(txn.amount),
          fees: parseFloat(txn.fees) || 0,
          notes: txn.notes || null,
        });
      }

      navigate(`/investments/${invId}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const isPPF = assetType === 'PPF' || assetType === 'SSY' || assetType === 'PF';
  const isMF = assetType === 'MUTUAL_FUND';
  const isIndianStock = assetType === 'INDIAN_STOCK';
  const isForeignStock = assetType === 'FOREIGN_STOCK';
  const isStock = isIndianStock || isForeignStock;
  const isBond = assetType === 'BOND';
  const isSGB = assetType === 'SGB';
  const isNPS = assetType === 'NPS';

  // Bond-specific form state
  const [bondForm, setBondForm] = useState({
    name: '',
    face_value: '1000',
    coupon_rate: '',
    coupon_frequency: 'ANNUAL',
    maturity_date: '',
    broker: 'Paytm Money',
    notes: '',
  });
  const [bondTxn, setBondTxn] = useState({
    transaction_type: 'BUY',
    transaction_date: new Date().toISOString().split('T')[0],
    units: '',
    price_per_unit: '',
    fees: '0',
    notes: '',
  });
  const bondAmount = bondTxn.units && bondTxn.price_per_unit
    ? (parseFloat(bondTxn.units) * parseFloat(bondTxn.price_per_unit)).toFixed(2)
    : '';

  const handleBondSubmit = async () => {
    setError('');
    setSubmitting(true);
    try {
      if (!bondForm.name) { setError('Name is required'); setSubmitting(false); return; }
      if (!portfolioId) { setError('Please select a portfolio first (from the top navbar)'); setSubmitting(false); return; }
      if (!bondForm.coupon_rate) { setError('Coupon rate is required'); setSubmitting(false); return; }
      if (!bondForm.maturity_date) { setError('Maturity date is required'); setSubmitting(false); return; }
      if (!bondTxn.units || !bondTxn.price_per_unit) { setError('Units and price are required'); setSubmitting(false); return; }

      const computedAmount = parseFloat(bondTxn.units) * parseFloat(bondTxn.price_per_unit);
      if (!computedAmount || isNaN(computedAmount)) { setError('Invalid units or price'); setSubmitting(false); return; }

      const inv = await createInvestment({
        name: bondForm.name,
        asset_type: assetType,
        coupon_rate: parseFloat(bondForm.coupon_rate),
        face_value: parseFloat(bondForm.face_value) || 1000,
        coupon_frequency: bondForm.coupon_frequency,
        maturity_date: bondForm.maturity_date,
        currency: 'INR',
        notes: bondForm.notes || null,
      });

      await addTransaction({
        investment_id: inv.id,
        portfolio_id: portfolioId || null,
        transaction_type: bondTxn.transaction_type,
        transaction_date: bondTxn.transaction_date,
        units: parseFloat(bondTxn.units),
        price_per_unit: parseFloat(bondTxn.price_per_unit),
        amount: computedAmount,
        fees: parseFloat(bondTxn.fees) || 0,
        broker: bondForm.broker || null,
        notes: bondTxn.notes || null,
      });

      navigate(`/investments/${inv.id}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };



  const brokerOptions = [
    { value: 'Sharekhan', label: 'Sharekhan' },
    { value: 'Groww', label: 'Groww' },
    { value: 'Zerodha', label: 'Zerodha' },
    { value: 'Angel', label: 'Angel One' },
    { value: 'ICICI', label: 'ICICI Direct' },
    { value: 'HDFC', label: 'HDFC Securities' },
    { value: 'Kotak', label: 'Kotak Securities' },
    { value: 'Other', label: 'Other' },
  ];

  return (
    <div className="mx-auto d-flex flex-column gap-4" style={{ maxWidth: 680 }}>
      <div>
        <button onClick={() => navigate(-1)} className="btn btn-link btn-sm text-muted text-decoration-none d-flex align-items-center gap-1 mb-2 p-0">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <h1 className="h4 fw-bold">Add Investment</h1>
      </div>

      {error && <Alert variant="danger" className="small py-2">{error}</Alert>}

      {/* Step 1: Choose Asset Type */}
      <Card className="shadow-sm">
        <Card.Body>
          <h2 className="h6 fw-semibold mb-3">1. Choose Asset Type</h2>
          <Row className="g-2" xs={2} sm={5}>
            {ASSET_TYPES.map((type) => (
              <Col key={type}>
                <button
                  onClick={() => {
                    setAssetType(type);
                    setForm({ ...form, name: '', ticker_symbol: '', amfi_code: '', currency: type === 'FOREIGN_STOCK' ? 'USD' : 'INR' });
                    setStockInfo(null);
                    setStockResults([]);
                    setStockQuery('');
                    setMfResults([]);
                    setMfSearch('');
                    setContractResult(null);
                    setContractPreview(null);
                    setPnlResult(null);
                    setError('');
                    setExpandedSection(null);
                    handleCASReset();
                    handleRsuGrantReset();
                  }}
                  className={`btn w-100 btn-sm border-2 ${
                    assetType === type
                      ? 'btn-outline-primary border-primary bg-primary bg-opacity-10'
                      : 'btn-outline-secondary'
                  }`}
                  title={type === 'SSY' ? 'Sukanya Samriddhi Yojana' : type === 'MUTUAL_FUND' ? 'Mutual Funds' : type === 'PPF' ? 'Public Provident Fund' : type === 'PF' ? 'Provident Fund' : undefined}
                >
                  {ASSET_TYPE_LABELS[type]}
                </button>
              </Col>
            ))}
          </Row>
        </Card.Body>
      </Card>

      {/* Indian Stocks: collapsible sections */}
      {isIndianStock && (
        <>
          {/* Upload Contract Notes */}
          <Card className="shadow-sm">
            <Card.Header
              className="d-flex align-items-center gap-2 bg-white py-2 px-3"
              style={{ cursor: 'pointer' }}
              onClick={() => toggleSection('contract')}
            >
              <Receipt size={20} className="text-primary" />
              <span className="h6 fw-semibold mb-0 flex-grow-1">Upload Contract Notes from Broker</span>
              <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                style={{ transition: 'transform 0.2s', transform: expandedSection === 'contract' ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </Card.Header>
            <Collapse in={expandedSection === 'contract'}>
              <div>
                <Card.Body className="pt-2">
              <p className="small text-muted mb-3">
                Upload contract note ZIP, HTM, or PDF files. Broker is auto-detected from the file.
              </p>

              {!contractPreview && !contractResult && (
                <>
                  <Form.Label className="small">Contract Note Files</Form.Label>
                  <Form.Control
                    ref={contractFileRef}
                    size="sm"
                    type="file"
                    accept=".zip,.htm,.html,.pdf"
                    multiple
                    onChange={(e) => setContractFiles(Array.from(e.target.files))}
                  />
                  {contractFiles.length > 0 && (
                    <div className="mt-2 small text-muted">
                      {contractFiles.length} file{contractFiles.length > 1 ? 's' : ''} selected
                    </div>
                  )}
                  <div className="mt-3">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={handleContractUpload}
                      disabled={contractUploading || !contractFiles.length}
                    >
                      {contractUploading ? <><Spinner size="sm" className="me-1" /> Parsing...</> : <><Upload size={14} className="me-1" /> Parse & Preview</>}
                    </Button>
                  </div>
                </>
              )}

              {/* Preview Table */}
              {contractPreview && (contractPreview.trades.length > 0 || contractPreview.intradayTrades?.length > 0) && (
                <div className="mt-3">
                  <div className="d-flex align-items-center gap-2 mb-2">
                    <span className="badge bg-info">{contractPreview.broker}</span>
                    {contractPreview.panNumber && <span className="badge bg-secondary">PAN: {contractPreview.panNumber}</span>}
                    <span className="badge bg-secondary">Client: {contractPreview.clientCode}</span>
                    <span className="small text-muted ms-auto">Portfolio: {contractPreview.portfolioName}</span>
                  </div>
                  <div className="table-responsive" style={{ maxHeight: 400, overflowY: 'auto' }}>
                    <table className="table table-sm table-bordered small mb-0">
                      <thead className="table-light sticky-top">
                        <tr>
                          <th>Stock</th>
                          <th>Date</th>
                          <th style={{ width: 60 }}>Type</th>
                          <th style={{ width: 70 }} className="text-end">Shares</th>
                          <th style={{ width: 90 }} className="text-end">Price</th>
                          <th style={{ width: 90 }} className="text-end">Charges</th>
                          <th style={{ width: 120 }} className="text-end">STT</th>
                          <th style={{ width: 100 }} className="text-end">Total</th>
                          <th style={{ width: 70 }} className="text-center">Status</th>
                          <th style={{ width: 30 }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {contractPreview.trades
                          .map((trade, i) => ({ trade, i }))
                          .filter(({ trade }) => trade.status === 'new' || trade.status === 'update')
                          .map(({ trade, i }) => (
                          <tr key={i}>
                            <td title={trade.isin || ''}>{trade.security}</td>
                            <td>{trade.tradeDate}</td>
                            <td>
                              <span className={`badge ${trade.type === 'BUY' ? 'bg-success' : 'bg-danger'}`}>
                                {trade.type}
                              </span>
                            </td>
                            <td className="text-end">{Number(trade.quantity).toLocaleString('en-IN', { maximumFractionDigits: 4 })}</td>
                            <td className="text-end">₹{Number(trade.rate).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                            <td className="text-end">₹{Number(trade.brokerage || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                            <td className="text-end">
                              {trade.status === 'update'
                                ? <span className="text-primary">₹{Number(trade.existing_stt || 0).toFixed(2)} → ₹{Number(trade.new_stt || 0).toFixed(2)}</span>
                                : `₹${Number(trade.stt || 0).toFixed(2)}`}
                            </td>
                            <td className="text-end">₹{trade.total?.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                            <td className="text-center">
                              {trade.status === 'new'
                                ? <span className="badge bg-success">New</span>
                                : <span className="badge" style={{ backgroundColor: '#dbeafe', color: '#1d4ed8' }}>Update</span>}
                            </td>
                            <td className="text-center">
                              <button
                                className="btn btn-sm btn-link text-danger p-0"
                                title="Remove"
                                onClick={() => removePreviewTrade(i)}
                              >×</button>
                            </td>
                          </tr>
                        ))}
                        {contractPreview.trades.filter(t => t.status === 'new' || t.status === 'update').length === 0 && (
                          <tr><td colSpan={10} className="text-center text-muted py-3">No new or updated trades — everything in these contract notes is already in sync.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  {contractPreview.intradayTrades?.length > 0 && (
                    <div className="mt-3">
                      <div className="fw-semibold small mb-1">Intraday trades (speculative business)</div>
                      <div className="table-responsive">
                        <table className="table table-sm table-bordered small mb-0">
                          <thead className="table-light">
                            <tr>
                              <th>Stock</th><th>Date</th><th className="text-end">Shares</th>
                              <th className="text-end">Buy</th><th className="text-end">Sell</th>
                              <th className="text-end">Gross P&amp;L</th><th className="text-end">Charges</th>
                              <th className="text-end">Net P&amp;L</th><th className="text-center">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {contractPreview.intradayTrades.map((trade, index) => (
                              <tr key={`${trade.isin || trade.security}-${index}`}>
                                <td title={trade.isin || ''}>{trade.security}</td>
                                <td>{trade.tradeDate}</td>
                                <td className="text-end">{Number(trade.quantity).toLocaleString('en-IN')}</td>
                                <td className="text-end">₹{Number(trade.buyRate).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                                <td className="text-end">₹{Number(trade.sellRate).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                                <td className="text-end">₹{Number(trade.grossProfit).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                                <td className="text-end">₹{Number(trade.fees).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                                <td className={`text-end fw-semibold ${Number(trade.netProfit) >= 0 ? 'text-success' : 'text-danger'}`}>₹{Number(trade.netProfit).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                                <td className="text-center">
                                  <span className={`badge ${trade.status === 'unchanged' ? 'bg-secondary' : 'bg-success'}`}>{trade.status}</span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                  {/* Summary row */}
                  <div className="d-flex justify-content-between mt-2 small text-muted">
                    <span>
                      {(() => {
                        const buys = contractPreview.trades.filter(t => t.type === 'BUY');
                        const sells = contractPreview.trades.filter(t => t.type === 'SELL');
                        const fmt = v => '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
                        const parts = [];
                        if (buys.length) parts.push(`${buys.length} buy${buys.length > 1 ? 's' : ''} @ ${fmt(buys.reduce((s, t) => s + (t.total || 0), 0))}`);
                        if (sells.length) parts.push(`${sells.length} sell${sells.length > 1 ? 's' : ''} @ ${fmt(sells.reduce((s, t) => s + (t.total || 0), 0))}`);
                        return parts.join(', ');
                      })()}
                    </span>
                  </div>
                  {/* Charges breakdown */}
                  {contractPreview.summary?.chargesBreakdown && (() => {
                    const b = contractPreview.summary.chargesBreakdown;
                    const items = [
                      ['Brokerage', b.brokerage],
                      ['STT', b.stt],
                      ['GST', b.gst],
                      ['Exchange', b.exchangeCharges],
                      ['Stamp', b.stampDuty],
                      ['SEBI', b.sebiCharges],
                      ['IPFT', b.ipftCharges],
                      ['DP', b.dpCharges],
                    ].filter(([, v]) => v);
                    if (!items.length) return null;
                    const fmt = v => '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
                    return (
                      <div className="mt-1 small text-muted">
                        <strong>Charges:</strong>{' '}
                        {items.map(([label, val], i) => (
                          <span key={label}>{i > 0 && ' · '}{label}: {fmt(val)}</span>
                        ))}
                        {b.total ? <span> · <strong>Total: {fmt(b.total)}</strong></span> : null}
                      </div>
                    );
                  })()}
                  <div className="d-flex gap-2 mt-3">
                    <Button
                      size="sm"
                      variant="success"
                      onClick={handleContractApprove}
                      disabled={contractImporting || ((contractPreview.summary?.newTrades || 0) + (contractPreview.summary?.updateTrades || 0)) === 0}
                    >
                      {contractImporting ? <><Spinner size="sm" className="me-1" /> Importing...</> : <><CheckCircle size={14} className="me-1" /> Import {(contractPreview.summary?.newTrades || 0)} new · {(contractPreview.summary?.updateTrades || 0)} update{(contractPreview.summary?.updateTrades || 0) !== 1 ? 's' : ''}</>}
                    </Button>
                    <Button size="sm" variant="outline-secondary" onClick={handleContractCancel}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              {contractResult && (
                <Alert variant="success" className="mt-3 small py-2">
                  <CheckCircle size={14} className="me-1" />
                  {contractResult.transactionsCreated > 0 && `Created ${contractResult.transactionsCreated} transaction${contractResult.transactionsCreated !== 1 ? 's' : ''}. `}
                  {contractResult.transactionsUpdated > 0 && `Updated ${contractResult.transactionsUpdated}. `}
                  {contractResult.transactionsSkipped > 0 && `Skipped ${contractResult.transactionsSkipped} (already imported). `}
                  {contractResult.intradayCreated > 0 && `Created ${contractResult.intradayCreated} intraday trade${contractResult.intradayCreated !== 1 ? 's' : ''}. `}
                  {contractResult.intradayUpdated > 0 && `Updated ${contractResult.intradayUpdated} intraday trade${contractResult.intradayUpdated !== 1 ? 's' : ''}. `}
                  {contractResult.intradaySkipped > 0 && `Skipped ${contractResult.intradaySkipped} intraday trade${contractResult.intradaySkipped !== 1 ? 's' : ''} (already imported). `}
                  {contractResult.investmentsCreated > 0 && `${contractResult.investmentsCreated} new stock${contractResult.investmentsCreated !== 1 ? 's' : ''} added.`}
                  <button className="btn btn-link btn-sm p-0 ms-2" onClick={() => { setContractResult(null); setContractFiles([]); if (contractFileRef.current) contractFileRef.current.value = ''; }}>
                    Upload more
                  </button>
                </Alert>
              )}
            </Card.Body>
              </div>
            </Collapse>
          </Card>

          {/* Add P&L Statement */}
          <Card className="shadow-sm">
            <Card.Header
              className="d-flex align-items-center gap-2 bg-white py-2 px-3"
              style={{ cursor: 'pointer' }}
              onClick={() => toggleSection('pnl')}
            >
              <FileText size={20} className="text-primary" />
              <span className="h6 fw-semibold mb-0 flex-grow-1">Add P&L Statement</span>
              <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                style={{ transition: 'transform 0.2s', transform: expandedSection === 'pnl' ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </Card.Header>
            <Collapse in={expandedSection === 'pnl'}>
              <div>
                <Card.Body className="pt-2">
              <p className="small text-muted mb-3">
                Upload your profit & loss or trade history report (Excel/CSV) from your broker.
              </p>

              <Row className="g-3 align-items-end">
                <Col md={6}>
                  <Form.Label className="small">Broker</Form.Label>
                  <Form.Select
                    size="sm"
                    value={pnlBroker}
                    onChange={(e) => setPnlBroker(e.target.value)}
                  >
                    <option value="">Select broker...</option>
                    {brokerOptions.map(b => (
                      <option key={b.value} value={b.value}>{b.label}</option>
                    ))}
                  </Form.Select>
                </Col>
                <Col md={6}>
                  <Form.Label className="small">P&L / Trade History File</Form.Label>
                  <Form.Control
                    ref={pnlFileRef}
                    size="sm"
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={(e) => setPnlFile(e.target.files[0] || null)}
                  />
                </Col>
              </Row>
              <div className="mt-3">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={handlePnlUpload}
                  disabled={pnlUploading || !pnlBroker || !pnlFile}
                >
                  {pnlUploading ? <><Spinner size="sm" className="me-1" /> Processing...</> : <><Upload size={14} className="me-1" /> Upload & Import</>}
                </Button>
              </div>
              {pnlResult && (
                <Alert variant="success" className="mt-3 small py-2">
                  <CheckCircle size={14} className="me-1" />
                  Imported {pnlResult.investmentsCreated} stock{pnlResult.investmentsCreated !== 1 ? 's' : ''} with {pnlResult.transactionsCreated} transaction{pnlResult.transactionsCreated !== 1 ? 's' : ''}.
                </Alert>
              )}
            </Card.Body>
              </div>
            </Collapse>
          </Card>

          {/* Add Stocks Manually */}
          <Card className="shadow-sm">
            <Card.Header
              className="d-flex align-items-center gap-2 bg-white py-2 px-3"
              style={{ cursor: 'pointer' }}
              onClick={() => toggleSection('manual')}
            >
              <Search size={20} className="text-primary" />
              <span className="h6 fw-semibold mb-0 flex-grow-1">Add Stocks Manually</span>
              <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                style={{ transition: 'transform 0.2s', transform: expandedSection === 'manual' ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </Card.Header>
            <Collapse in={expandedSection === 'manual'}>
              <div>
                <Card.Body className="pt-2">
              <p className="small text-muted mb-3">Search for a stock and enter the transaction details.</p>

              {/* Transaction Type */}
              <div className="mb-3">
                <Form.Label className="small fw-medium">Transaction Type</Form.Label>
                <div className="d-flex flex-wrap gap-2 mt-1">
                  {STOCK_TXN_TYPES.map((t) => (
                    <Form.Check
                      key={t}
                      inline
                      type="radio"
                      name="stockTxnType"
                      id={`txn-${t}`}
                      label={t.charAt(0) + t.slice(1).toLowerCase()}
                      checked={txn.transaction_type === t}
                      onChange={() => setTxn({ ...txn, transaction_type: t })}
                    />
                  ))}
                </div>
              </div>

              <Row className="g-3">
                {/* Stock Name / Search */}
                <Col md={6}>
                  <Form.Label className="small">Stock Name</Form.Label>
                  <div className="d-flex gap-2">
                    <Form.Control
                      size="sm"
                      type="text"
                      value={stockQuery}
                      onChange={(e) => { setStockQuery(e.target.value); setStockInfo(null); setStockResults([]); }}
                      onKeyDown={(e) => e.key === 'Enter' && handleStockSearch()}
                      placeholder="e.g., ICICI, Nifty ETF, Reliance"
                    />
                    <Button size="sm" variant="primary" onClick={handleStockSearch} disabled={searching}>
                      {searching ? <Spinner size="sm" animation="border" /> : <Search size={16} />}
                    </Button>
                  </div>
                  {stockResults.length > 0 && (
                    <div className="border rounded mt-1 bg-white shadow-sm" style={{ maxHeight: 200, overflowY: 'auto' }}>
                      {stockResults.map((r, i) => (
                        <div
                          key={i}
                          className="px-3 py-2 border-bottom small d-flex justify-content-between align-items-center"
                          style={{ cursor: 'pointer' }}
                          onClick={() => selectStock(r)}
                          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f0f0f0'}
                          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = ''}
                        >
                          <div>
                            <strong>{r.symbol}</strong>
                            <span className="text-muted ms-2">{r.name}</span>
                          </div>
                          <span className="badge bg-secondary">{r.type}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {stockInfo && (
                    <div className="mt-2 p-2 bg-success bg-opacity-10 rounded d-flex align-items-center gap-2">
                      <CheckCircle size={14} className="text-success" />
                      <span className="small text-success">
                        <strong>{stockInfo.name}</strong> ({form.ticker_symbol}) — ₹{stockInfo.price?.toFixed(2)}
                      </span>
                    </div>
                  )}
                </Col>

                {/* Notes */}
                <Col md={6}>
                  <Form.Label className="small">Notes</Form.Label>
                  <Form.Control
                    size="sm"
                    type="text"
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    placeholder="Optional notes"
                  />
                </Col>

                {/* Date */}
                <Col md={6}>
                  <Form.Label className="small">Date of Investment</Form.Label>
                  <Form.Control
                    size="sm"
                    type="date"
                    value={txn.transaction_date}
                    onChange={(e) => updateTxn('transaction_date', e.target.value)}
                  />
                </Col>

                {/* Shares */}
                <Col md={6}>
                  <Form.Label className="small">No. of Shares</Form.Label>
                  <Form.Control
                    size="sm"
                    type="number"
                    step="0.001"
                    value={txn.units}
                    onChange={(e) => updateTxn('units', e.target.value)}
                    placeholder="Number of shares"
                  />
                </Col>

                {/* Price */}
                <Col md={6}>
                  <Form.Label className="small">Price per Share (₹)</Form.Label>
                  <Form.Control
                    size="sm"
                    type="number"
                    step="0.01"
                    value={txn.price_per_unit}
                    onChange={(e) => updateTxn('price_per_unit', e.target.value)}
                    placeholder={txn.transaction_type === 'SELL' ? 'Selling price' : 'Purchase price'}
                  />
                </Col>

                {/* Total Amount (computed) */}
                <Col md={6}>
                  <Form.Label className="small">Total Amount (₹)</Form.Label>
                  <div className="form-control form-control-sm bg-light" style={{ minHeight: '31px' }}>
                    {txn.units && txn.price_per_unit
                      ? '₹' + (parseFloat(txn.units) * parseFloat(txn.price_per_unit)).toLocaleString('en-IN', { maximumFractionDigits: 2 })
                      : <span className="text-muted">Auto-calculated</span>}
                  </div>
                </Col>

                {/* Fees */}
                <Col md={6}>
                  <Form.Label className="small">Charges (₹)</Form.Label>
                  <Form.Control
                    size="sm"
                    type="number"
                    step="0.01"
                    value={txn.fees}
                    onChange={(e) => updateTxn('fees', e.target.value)}
                    placeholder="0"
                  />
                </Col>
              </Row>

              <div className="d-flex justify-content-end gap-2 mt-4">
                <Button variant="outline-secondary" size="sm" onClick={() => navigate(-1)}>
                  Cancel
                </Button>
                <Button variant="primary" size="sm" onClick={handleSubmit} disabled={submitting}>
                  {submitting ? 'Adding...' : 'Add Investment'}
                </Button>
              </div>
            </Card.Body>
              </div>
            </Collapse>
          </Card>


        </>
      )}

      {/* Bond/SGB form */}
      {(isBond || isSGB) && (
        <>
          <Card className="shadow-sm">
            <Card.Body>
              <h2 className="h6 fw-semibold mb-3">2. {isSGB ? 'SGB' : 'Bond'} Details</h2>
              <Row className="g-3">
                <Col md={8}>
                  <Form.Label className="small">Name {isSGB && <span className="text-muted" style={{fontSize: '0.75rem'}}>(Format: SGB 2.50 05/01/2029 Series-IX)</span>}</Form.Label>
                  <Form.Control
                    size="sm"
                    type="text"
                    value={bondForm.name}
                    onChange={(e) => setBondForm({ ...bondForm, name: e.target.value })}
                    placeholder={isSGB ? 'e.g., SGB 2.50 05/01/2029 Series-IX' : 'e.g., Shriram Finance NCD 9.05%'}
                    required
                  />
                </Col>
                <Col md={4}>
                  <Form.Label className="small">Broker</Form.Label>
                  <Form.Select
                    size="sm"
                    value={bondForm.broker}
                    onChange={(e) => setBondForm({ ...bondForm, broker: e.target.value })}
                  >
                    {[
                      { value: 'Paytm Money', label: 'Paytm Money' },
                      ...brokerOptions,
                    ].map(b => (
                      <option key={b.value} value={b.value}>{b.label}</option>
                    ))}
                  </Form.Select>
                </Col>
                <Col md={3}>
                  <Form.Label className="small">Face Value (₹)</Form.Label>
                  <Form.Control
                    size="sm"
                    type="number"
                    step="0.01"
                    value={bondForm.face_value}
                    onChange={(e) => setBondForm({ ...bondForm, face_value: e.target.value })}
                    placeholder="1000"
                  />
                </Col>
                <Col md={3}>
                  <Form.Label className="small">Coupon Rate (% p.a.)</Form.Label>
                  <Form.Control
                    size="sm"
                    type="number"
                    step="0.01"
                    value={bondForm.coupon_rate}
                    onChange={(e) => setBondForm({ ...bondForm, coupon_rate: e.target.value })}
                    placeholder="e.g., 9.05"
                    required
                  />
                </Col>
                <Col md={3}>
                  <Form.Label className="small">Coupon Frequency</Form.Label>
                  <Form.Select
                    size="sm"
                    value={bondForm.coupon_frequency}
                    onChange={(e) => setBondForm({ ...bondForm, coupon_frequency: e.target.value })}
                  >
                    <option value="MONTHLY">Monthly</option>
                    <option value="QUARTERLY">Quarterly</option>
                    <option value="SEMI_ANNUAL">Semi-Annual</option>
                    <option value="ANNUAL">Annual</option>
                  </Form.Select>
                </Col>
                <Col md={3}>
                  <Form.Label className="small">Maturity Date</Form.Label>
                  <Form.Control
                    size="sm"
                    type="date"
                    value={bondForm.maturity_date}
                    onChange={(e) => setBondForm({ ...bondForm, maturity_date: e.target.value })}
                    required
                  />
                </Col>
                <Col md={12}>
                  <Form.Label className="small">Notes</Form.Label>
                  <Form.Control
                    size="sm"
                    type="text"
                    value={bondForm.notes}
                    onChange={(e) => setBondForm({ ...bondForm, notes: e.target.value })}
                    placeholder="Optional notes (e.g., ISIN, series)"
                  />
                </Col>
              </Row>
            </Card.Body>
          </Card>

          <Card className="shadow-sm">
            <Card.Body>
              <h2 className="h6 fw-semibold mb-3">3. Purchase / Sale / Redemption</h2>
              <div className="mb-3">
                <div className="d-flex flex-wrap gap-2">
                  {['BUY', 'SELL', 'REDEMPTION'].map((t) => (
                    <Form.Check
                      key={t}
                      inline
                      type="radio"
                      name="bondTxnType"
                      id={`bond-txn-${t}`}
                      label={{ BUY: 'Buy', SELL: 'Sell', REDEMPTION: 'Redemption' }[t]}
                      checked={bondTxn.transaction_type === t}
                      onChange={() => setBondTxn({ ...bondTxn, transaction_type: t })}
                    />
                  ))}
                </div>
              </div>
              <Row className="g-3">
                <Col md={4}>
                  <Form.Label className="small">Date</Form.Label>
                  <Form.Control
                    size="sm"
                    type="date"
                    value={bondTxn.transaction_date}
                    onChange={(e) => setBondTxn({ ...bondTxn, transaction_date: e.target.value })}
                  />
                </Col>
                <Col md={4}>
                  <Form.Label className="small">No. of Bonds</Form.Label>
                  <Form.Control
                    size="sm"
                    type="number"
                    step="1"
                    value={bondTxn.units}
                    onChange={(e) => setBondTxn({ ...bondTxn, units: e.target.value })}
                    placeholder="e.g., 5"
                  />
                </Col>
                <Col md={4}>
                  <Form.Label className="small">Price per Bond (₹)</Form.Label>
                  <Form.Control
                    size="sm"
                    type="number"
                    step="0.01"
                    value={bondTxn.price_per_unit}
                    onChange={(e) => setBondTxn({ ...bondTxn, price_per_unit: e.target.value })}
                    placeholder="e.g., 1000"
                  />
                </Col>
                <Col md={4}>
                  <Form.Label className="small">Total Amount (₹)</Form.Label>
                  <div className="form-control form-control-sm bg-light" style={{ minHeight: '31px' }}>
                    {bondAmount
                      ? '₹' + parseFloat(bondAmount).toLocaleString('en-IN', { maximumFractionDigits: 2 })
                      : <span className="text-muted">Auto-calculated</span>}
                  </div>
                </Col>
                <Col md={4}>
                  <Form.Label className="small">Charges (₹)</Form.Label>
                  <Form.Control
                    size="sm"
                    type="number"
                    step="0.01"
                    value={bondTxn.fees}
                    onChange={(e) => setBondTxn({ ...bondTxn, fees: e.target.value })}
                    placeholder="0"
                  />
                </Col>
                <Col md={4}>
                  <Form.Label className="small">Notes</Form.Label>
                  <Form.Control
                    size="sm"
                    type="text"
                    value={bondTxn.notes}
                    onChange={(e) => setBondTxn({ ...bondTxn, notes: e.target.value })}
                    placeholder="Optional"
                  />
                </Col>
              </Row>
            </Card.Body>
          </Card>

          <div className="d-flex justify-content-end gap-2">
            <Button variant="outline-secondary" onClick={() => navigate(-1)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleBondSubmit} disabled={submitting}>
              {submitting ? 'Adding...' : 'Add Bond'}
            </Button>
          </div>
        </>
      )}

      {/* NPS: collapsible sections */}
      {isNPS && (
        <>
          {/* Upload NPS Statements */}
          <Card className="shadow-sm">
            <Card.Header
              className="d-flex align-items-center gap-2 bg-white py-2 px-3"
              style={{ cursor: 'pointer' }}
              onClick={() => toggleSection('nps-upload')}
            >
              <Upload size={20} className="text-primary" />
              <span className="h6 fw-semibold mb-0 flex-grow-1">Upload NPS Statements</span>
              <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                style={{ transition: 'transform 0.2s', transform: expandedSection === 'nps-upload' ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </Card.Header>
            <Collapse in={expandedSection === 'nps-upload'}>
              <div>
                <Card.Body className="pt-2">
                  <p className="small text-muted mb-3">
                    Upload NPS transaction statements (CSV from Protean e-NPS or PDF from Karvy/KFintech).
                  </p>

                  {npsError && (
                    <Alert variant="danger" className="small py-2 d-flex align-items-center gap-2">
                      <AlertCircle size={14} className="flex-shrink-0" />
                      {npsError}
                    </Alert>
                  )}

                  {npsResult && (
                    <Alert variant="success" className="small py-2">
                      <CheckCircle size={14} className="me-1" />
                      Imported {npsResult.imported} transaction{npsResult.imported !== 1 ? 's' : ''} across {npsResult.schemes?.length || 0} scheme{(npsResult.schemes?.length || 0) !== 1 ? 's' : ''}.
                      {npsResult.skipped > 0 && <span className="text-muted ms-1">({npsResult.skipped} duplicates skipped)</span>}
                      <button className="btn btn-link btn-sm p-0 ms-2" onClick={handleNPSReset}>Upload more</button>
                    </Alert>
                  )}

                  {!npsPreview && !npsResult && (
                    <>
                      <Row className="g-3 align-items-end">
                        <Col md={12}>
                          <Form.Label className="small">Statement Files (CSV / PDF)</Form.Label>
                          <Form.Control
                            ref={npsFileRef}
                            size="sm"
                            type="file"
                            accept=".csv,.pdf"
                            multiple
                            onChange={(e) => setNpsFiles(Array.from(e.target.files))}
                          />
                        </Col>
                      </Row>
                      <Row className="g-3 align-items-end mt-0">
                        <Col md={12}>
                          <Form.Label className="small">
                            Salary Slips <span className="text-muted">(PDF, optional — populates NPS charge fees)</span>
                          </Form.Label>
                          <Form.Control
                            ref={npsPayslipRef}
                            size="sm"
                            type="file"
                            accept=".pdf"
                            multiple
                            onChange={(e) => setNpsPayslipFiles(Array.from(e.target.files))}
                          />
                          <Form.Text className="text-muted" style={{ fontSize: '0.7rem' }}>
                            Reads the monthly “NPS charges deduction” and splits it across schemes as fees.
                          </Form.Text>
                        </Col>
                      </Row>
                      {npsFiles.some(f => f.name.toLowerCase().endsWith('.pdf')) && (
                        <Row className="g-3 mt-0">
                          <Col md={6}>
                            <Form.Label className="small">PDF Password <span className="text-muted">(usually PRAN)</span></Form.Label>
                            <Form.Control
                              size="sm"
                              type="password"
                              placeholder="Enter PDF password"
                              value={npsPassword}
                              onChange={(e) => setNpsPassword(e.target.value)}
                            />
                          </Col>
                        </Row>
                      )}
                      {npsFiles.length > 0 && (
                        <div className="mt-2 small text-muted">
                          {npsFiles.length} file{npsFiles.length > 1 ? 's' : ''} selected
                          {npsPayslipFiles.length > 0 && <> · {npsPayslipFiles.length} salary slip{npsPayslipFiles.length > 1 ? 's' : ''}</>}
                        </div>
                      )}
                      <div className="mt-3">
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={handleNPSUpload}
                          disabled={npsUploading || !npsFiles.length}
                        >
                          {npsUploading ? <><Spinner size="sm" className="me-1" /> Parsing...</> : <><Upload size={14} className="me-1" /> Parse & Preview</>}
                        </Button>
                      </div>
                    </>
                  )}

                  {/* NPS Preview */}
                  {npsPreview && (
                    <div className="mt-3">
                      <div className="d-flex align-items-center gap-2 mb-2 flex-wrap">
                        <span className="badge bg-info">NPS</span>
                        {npsPreview.pran && <span className="badge bg-secondary">PRAN: {npsPreview.pran}</span>}
                        {npsPreview.subscriberName && <span className="badge bg-secondary">{npsPreview.subscriberName}</span>}
                        <span className="small text-muted ms-auto">
                          {npsPreview.summary.totalSchemes} scheme{npsPreview.summary.totalSchemes !== 1 ? 's' : ''} ·{' '}
                          <span className="text-success fw-medium">{npsPreview.summary.newTransactions} new</span>
                          {npsPreview.summary.existingTransactions > 0 && <> · {npsPreview.summary.existingTransactions} in DB</>}
                        </span>
                      </div>

                      {/* Select All */}
                      <div className="d-flex align-items-center gap-2 mb-2">
                        <Form.Check
                          type="checkbox"
                          checked={npsSelectedSchemes.size === npsPreview.schemes.filter(s => s.newTransactionCount > 0).length}
                          onChange={() => {
                            const withNew = npsPreview.schemes.map((s, i) => s.newTransactionCount > 0 ? i : null).filter(i => i !== null);
                            if (npsSelectedSchemes.size === withNew.length) setNpsSelectedSchemes(new Set());
                            else setNpsSelectedSchemes(new Set(withNew));
                          }}
                          label={<span className="small text-muted">Select all schemes with new transactions</span>}
                        />
                      </div>

                      {npsPreview.payslips?.filesUploaded > 0 && (
                        <div className="small mb-2 d-flex align-items-center gap-1 flex-wrap">
                          <span className="badge bg-light text-dark border">
                            {npsPreview.payslips.filesUploaded} salary slip{npsPreview.payslips.filesUploaded > 1 ? 's' : ''}
                          </span>
                          {npsPreview.payslips.monthsFound?.length > 0 ? (
                            <span className="text-muted">
                              Charges found for {npsPreview.payslips.monthsFound.join(', ')} ·{' '}
                              <span className="text-success">{npsPreview.payslips.transactionsPriced} contribution{npsPreview.payslips.transactionsPriced !== 1 ? 's' : ''} priced</span>
                            </span>
                          ) : (
                            <span className="text-warning">No “NPS charges deduction” line found in the uploaded slips.</span>
                          )}
                        </div>
                      )}

                      {/* Scheme List */}
                      {npsPreview.schemes.map((scheme, idx) => {
                        const isExpanded = npsExpandedScheme === idx;
                        const isSelected = npsSelectedSchemes.has(idx);
                        const hasNew = scheme.newTransactionCount > 0;
                        const NPS_TYPE_COLORS = {
                          EMPLOYER_CONTRIBUTION: 'bg-success', VOLUNTARY_CONTRIBUTION: 'bg-info',
                          AMC: 'bg-warning text-dark', CHARGES: 'bg-warning text-dark', BUY: 'bg-success', SELL: 'bg-danger',
                          TRANSFER_IN: 'bg-primary', TRANSFER_OUT: 'bg-danger',
                        };
                        const NPS_TYPE_LABELS = {
                          EMPLOYER_CONTRIBUTION: 'Employer', VOLUNTARY_CONTRIBUTION: 'Voluntary',
                          AMC: 'AMC', CHARGES: 'Legacy Charges', BUY: 'Buy', SELL: 'Sell',
                          TRANSFER_IN: 'Transfer In', TRANSFER_OUT: 'Transfer Out',
                        };

                        return (
                          <div key={idx} className="border rounded mb-2 overflow-hidden" style={{ opacity: hasNew ? 1 : 0.6 }}>
                            <div className="d-flex align-items-center px-3 py-2" style={{ backgroundColor: isSelected ? '#eff6ff' : 'transparent' }}>
                              <Form.Check
                                type="checkbox"
                                checked={isSelected}
                                disabled={!hasNew}
                                onChange={() => {
                                  const next = new Set(npsSelectedSchemes);
                                  if (next.has(idx)) next.delete(idx);
                                  else next.add(idx);
                                  setNpsSelectedSchemes(next);
                                }}
                                className="me-2"
                              />
                              <button
                                onClick={() => setNpsExpandedScheme(isExpanded ? null : idx)}
                                className="flex-grow-1 bg-transparent border-0 text-start p-0 d-flex align-items-center"
                                style={{ cursor: 'pointer' }}
                              >
                                <div className="flex-grow-1">
                                  <div className="small fw-medium">{scheme.schemeName}</div>
                                  <div className="d-flex align-items-center gap-2" style={{ fontSize: '0.7rem' }}>
                                    {scheme.pran && <span className="text-muted font-monospace">PRAN: {scheme.pran}</span>}
                                    {scheme.isNew && <span className="badge" style={{ fontSize: '0.6rem', backgroundColor: '#dbeafe', color: '#1d4ed8' }}>New Investment</span>}
                                  </div>
                                </div>
                                <div className="d-flex align-items-center gap-2 ms-2">
                                  {hasNew ? (
                                    <span className="badge" style={{ fontSize: '0.65rem', backgroundColor: '#dcfce7', color: '#15803d' }}>{scheme.newTransactionCount} new</span>
                                  ) : (
                                    <span className="badge bg-light text-muted" style={{ fontSize: '0.65rem' }}>all in DB</span>
                                  )}
                                  {scheme.existingTransactionCount > 0 && (
                                    <span className="badge bg-light text-muted" style={{ fontSize: '0.65rem' }}>{scheme.existingTransactionCount} existing</span>
                                  )}
                                  <ChevronDown size={14} className="text-muted" style={{ transition: 'transform 0.2s', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }} />
                                </div>
                              </button>
                            </div>
                            {isExpanded && (
                              <div className="border-top">
                                <div className="table-responsive" style={{ maxHeight: 300, overflowY: 'auto' }}>
                                  <Table size="sm" className="mb-0" style={{ fontSize: '0.75rem' }}>
                                    <thead className="table-light">
                                      <tr>
                                        <th className="px-2 py-1">Date</th>
                                        <th className="px-2 py-1">Type</th>
                                        <th className="px-2 py-1 text-end">Amount</th>
                                        <th className="px-2 py-1 text-end">Fees</th>
                                        <th className="px-2 py-1 text-end">NAV</th>
                                        <th className="px-2 py-1 text-end">Units</th>
                                        <th className="px-2 py-1">Description</th>
                                        <th className="px-2 py-1">Status</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {scheme.transactions.map((t, ti) => (
                                        <tr key={ti} style={{ opacity: t.isNew ? 1 : 0.5 }}>
                                          {(() => {
                                            const typeKey = String(t.type || '').trim().toUpperCase();
                                            const typeBadgeClass = NPS_TYPE_COLORS[typeKey] || 'bg-light text-dark border';
                                            const typeLabel = NPS_TYPE_LABELS[typeKey] || typeKey || 'UNKNOWN';
                                            return (
                                              <>
                                          <td className="px-2 py-1 text-nowrap">{t.date}</td>
                                          <td className="px-2 py-1">
                                            <span className={`badge ${typeBadgeClass}`} style={{ fontSize: '0.65rem' }}>
                                              {typeLabel}
                                            </span>
                                          </td>
                                          <td className="px-2 py-1 text-end">{formatCurrency(t.amount)}</td>
                                          <td className="px-2 py-1 text-end text-muted">{t.charges ? formatCurrency(t.charges) : '-'}</td>
                                          <td className="px-2 py-1 text-end">{t.nav ? t.nav.toFixed(4) : '-'}</td>
                                          <td className="px-2 py-1 text-end">{t.units ? t.units.toFixed(4) : '-'}</td>
                                          <td className="px-2 py-1 text-muted text-truncate" style={{ maxWidth: 180 }}>{t.particulars}</td>
                                          <td className="px-2 py-1">
                                            {t.isNew ? (
                                              <span className="badge" style={{ fontSize: '0.6rem', backgroundColor: '#dcfce7', color: '#15803d' }}>New</span>
                                            ) : (
                                              <span className="badge bg-light text-muted" style={{ fontSize: '0.6rem' }}>In DB</span>
                                            )}
                                          </td>
                                              </>
                                            );
                                          })()}
                                        </tr>
                                      ))}
                                    </tbody>
                                  </Table>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {/* Import Bar */}
                      <div className="bg-light border rounded p-2 mt-3 d-flex align-items-center justify-content-between">
                        <div className="small text-muted">
                          <strong>{npsPreview.schemes.filter((_, i) => npsSelectedSchemes.has(i)).reduce((s, sc) => s + sc.newTransactionCount, 0)}</strong> new transactions selected
                        </div>
                        <div className="d-flex gap-2">
                          <Button size="sm" variant="outline-secondary" onClick={handleNPSReset}>Cancel</Button>
                          <Button
                            size="sm" variant="success"
                            onClick={handleNPSImport}
                            disabled={npsImporting || npsSelectedSchemes.size === 0}
                          >
                            {npsImporting ? <><Spinner size="sm" className="me-1" /> Importing...</> : <><CheckCircle size={14} className="me-1" /> Approve & Import</>}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </Card.Body>
              </div>
            </Collapse>
          </Card>

          {/* Add NPS Manually */}
          <Card className="shadow-sm">
            <Card.Header
              className="d-flex align-items-center gap-2 bg-white py-2 px-3"
              style={{ cursor: 'pointer' }}
              onClick={() => toggleSection('nps-manual')}
            >
              <Search size={20} className="text-primary" />
              <span className="h6 fw-semibold mb-0 flex-grow-1">Add NPS Transaction Manually</span>
              <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                style={{ transition: 'transform 0.2s', transform: expandedSection === 'nps-manual' ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </Card.Header>
            <Collapse in={expandedSection === 'nps-manual'}>
              <div>
                <Card.Body className="pt-2">
                  <p className="small text-muted mb-3">Enter NPS scheme and transaction details manually.</p>

                  {/* Transaction Type */}
                  <div className="mb-3">
                    <Form.Label className="small fw-medium">Transaction Type</Form.Label>
                    <div className="d-flex flex-wrap gap-2 mt-1">
                      {NPS_TXN_TYPES.map((t) => (
                        <Form.Check
                          key={t.value}
                          inline
                          type="radio"
                          name="npsTxnType"
                          id={`nps-txn-${t.value}`}
                          label={t.label}
                          checked={npsTxn.transaction_type === t.value}
                          onChange={() => setNpsTxn({ ...npsTxn, transaction_type: t.value })}
                          className="small"
                        />
                      ))}
                    </div>
                  </div>

                  {/* Source (Employer/Voluntary) — only for BUY */}
                  {npsTxn.transaction_type === 'BUY' && (
                    <div className="mb-3">
                      <Form.Label className="small fw-medium">Contribution Source</Form.Label>
                      <div className="d-flex flex-wrap gap-2 mt-1">
                        {NPS_SOURCES.map((s) => (
                          <Form.Check
                            key={s.value}
                            inline
                            type="radio"
                            name="npsSource"
                            id={`nps-src-${s.value || 'other'}`}
                            label={s.label}
                            checked={npsTxn.source === s.value}
                            onChange={() => setNpsTxn({ ...npsTxn, source: s.value })}
                            className="small"
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  <Row className="g-3">
                    <Col md={8}>
                      <Form.Label className="small">NPS Scheme Name</Form.Label>
                      <Form.Control
                        size="sm"
                        type="text"
                        value={npsForm.name}
                        onChange={(e) => setNpsForm({ ...npsForm, name: e.target.value })}
                        placeholder="e.g., SBI PENSION FUND SCHEME E - TIER I"
                        required
                      />
                    </Col>
                    <Col md={4}>
                      <Form.Label className="small">PRAN</Form.Label>
                      <Form.Control
                        size="sm"
                        type="text"
                        value={npsForm.account_number}
                        onChange={(e) => setNpsForm({ ...npsForm, account_number: e.target.value })}
                        placeholder="PRAN number"
                      />
                    </Col>
                    <Col md={6}>
                      <Form.Label className="small">Date</Form.Label>
                      <Form.Control
                        size="sm"
                        type="date"
                        value={npsTxn.transaction_date}
                        onChange={(e) => updateNpsTxn('transaction_date', e.target.value)}
                      />
                    </Col>
                    <Col md={6}>
                      <Form.Label className="small">Amount (₹)</Form.Label>
                      <Form.Control
                        size="sm"
                        type="number"
                        step="0.01"
                        value={npsTxn.amount}
                        onChange={(e) => updateNpsTxn('amount', e.target.value)}
                        placeholder="Transaction amount"
                      />
                    </Col>
                    <Col md={4}>
                      <Form.Label className="small">NAV</Form.Label>
                      <Form.Control
                        size="sm"
                        type="number"
                        step="0.0001"
                        value={npsTxn.price_per_unit}
                        onChange={(e) => updateNpsTxn('price_per_unit', e.target.value)}
                        placeholder="NAV at transaction"
                      />
                    </Col>
                    <Col md={4}>
                      <Form.Label className="small">Units</Form.Label>
                      <Form.Control
                        size="sm"
                        type="number"
                        step="0.0001"
                        value={npsTxn.units}
                        onChange={(e) => updateNpsTxn('units', e.target.value)}
                        placeholder="Number of units"
                      />
                    </Col>
                    <Col md={4}>
                      <Form.Label className="small">Charges (₹)</Form.Label>
                      <Form.Control
                        size="sm"
                        type="number"
                        step="0.01"
                        value={npsTxn.fees}
                        onChange={(e) => setNpsTxn({ ...npsTxn, fees: e.target.value })}
                        placeholder="0"
                      />
                    </Col>
                    <Col md={12}>
                      <Form.Label className="small">Notes</Form.Label>
                      <Form.Control
                        size="sm"
                        type="text"
                        value={npsForm.notes}
                        onChange={(e) => setNpsForm({ ...npsForm, notes: e.target.value })}
                        placeholder="Optional notes"
                      />
                    </Col>
                  </Row>

                  <div className="d-flex justify-content-end gap-2 mt-4">
                    <Button variant="outline-secondary" size="sm" onClick={() => navigate(-1)}>Cancel</Button>
                    <Button variant="primary" size="sm" onClick={handleNPSManualSubmit} disabled={submitting}>
                      {submitting ? 'Adding...' : 'Add NPS Transaction'}
                    </Button>
                  </div>
                </Card.Body>
              </div>
            </Collapse>
          </Card>
        </>
      )}

      {/* Mutual Funds: collapsible sections */}
      {isMF && (
        <>
          {/* Upload CAS */}
          <Card className="shadow-sm">
            <Card.Header
              className="d-flex align-items-center gap-2 bg-white py-2 px-3"
              style={{ cursor: 'pointer' }}
              onClick={() => toggleSection('cas')}
            >
              <Upload size={20} className="text-primary" />
              <span className="h6 fw-semibold mb-0 flex-grow-1">Upload CAS Statement</span>
              <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                style={{ transition: 'transform 0.2s', transform: expandedSection === 'cas' ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </Card.Header>
            <Collapse in={expandedSection === 'cas'}>
              <div>
                <Card.Body className="pt-2">
                  <p className="small text-muted mb-3">
                    Upload CAS PDF from CAMS / KFintech / CDSL / NSDL. Broker is auto-detected.
                  </p>

                  {casError && (
                    <Alert variant="danger" className="small py-2 d-flex align-items-center gap-2">
                      <AlertCircle size={14} className="flex-shrink-0" />
                      {casError}
                    </Alert>
                  )}

                  {casResult && (
                    <Alert variant="success" className="small py-2">
                      <CheckCircle size={14} className="me-1" />
                      Successfully imported {casResult.imported} {casResult.schemes ? 'transaction' : 'investment'}{casResult.imported !== 1 ? 's' : ''} from CAS.
                      {casResult.updated > 0 && <span className="text-muted ms-1">({casResult.updated} updated)</span>}
                      {casResult.skipped > 0 && <span className="text-muted ms-1">({casResult.skipped} duplicates skipped)</span>}
                      <button className="btn btn-link btn-sm p-0 ms-2" onClick={handleCASReset}>
                        Upload another
                      </button>
                    </Alert>
                  )}

                  {!casPreview && !casResult && (
                    <>
                      <Row className="g-3 align-items-end">
                        <Col md={6}>
                          <Form.Label className="small">CAS PDF File</Form.Label>
                          <Form.Control
                            ref={casFileRef}
                            size="sm"
                            type="file"
                            accept="application/pdf"
                            onChange={(e) => setCasFile(e.target.files?.[0] || null)}
                          />
                        </Col>
                        <Col md={6}>
                          <Form.Label className="small">PDF Password <span className="text-muted">(optional)</span></Form.Label>
                          <Form.Control
                            type="password"
                            size="sm"
                            placeholder={casSelectedPortfolio?.pan_number ? `Use PAN (${casSelectedPortfolio.pan_number})` : 'Enter PDF password'}
                            value={casPassword}
                            onChange={(e) => setCasPassword(e.target.value)}
                          />
                        </Col>
                      </Row>
                      {!casSelectedPortfolio?.pan_number && !casPassword && (
                        <div className="text-warning small mt-1">
                          No PAN set on portfolio. Enter PDF password or add PAN first.
                        </div>
                      )}
                      <div className="mt-3">
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={handleCASUpload}
                          disabled={casUploading || !casFile}
                        >
                          {casUploading ? (
                            <><Spinner size="sm" className="me-1" /> Parsing...</>
                          ) : (
                            <><Upload size={14} className="me-1" /> Parse & Preview</>
                          )}
                        </Button>
                      </div>
                    </>
                  )}

                  {/* CAS Preview */}
                  {casPreview && casPreview.casType === 'cams' && (
                    <CAMSCASPreview
                      preview={casPreview}
                      selectedSchemes={casSelectedSchemes}
                      setSelectedSchemes={setCasSelectedSchemes}
                      expandedScheme={casExpandedScheme}
                      setExpandedScheme={setCasExpandedScheme}
                      onImport={handleCASImport}
                      onCancel={handleCASReset}
                      importing={casImporting}
                      formatCurrency={formatCurrency}
                    />
                  )}

                  {casPreview && casPreview.casType !== 'cams' && (
                    <div className="mt-3">
                      <div className="d-flex align-items-center gap-2 mb-2 flex-wrap">
                        <span className="badge bg-info">{casPreview.casType === 'nsdl' ? 'NSDL' : 'CDSL'} CAS</span>
                        <span className="badge bg-secondary">{casPreview.investorName}</span>
                        <span className="small text-muted ms-auto">
                          {casPreview.summary.totalMFs} funds · {formatCurrency(casPreview.portfolioValue)}
                        </span>
                      </div>

                      {/* Mutual Funds */}
                      {casPreview.mutualFunds.length > 0 && (
                        <CASHoldingTable
                          title="Mutual Funds & ETFs" emoji="📊"
                          items={casPreview.mutualFunds} selected={casSelectedMFs} setSelected={setCasSelectedMFs}
                          open={casShowMFs} toggle={() => setCasShowMFs(v => !v)}
                          columns={['Name', 'Source', 'Units', 'NAV/Price', 'Value']}
                          renderRow={(h) => [
                            <div>
                              <span className="fw-medium">{h.name}</span>
                              {h.folio && <span className="text-muted ms-1" style={{ fontSize: '0.75rem' }}>({h.folio})</span>}
                            </div>,
                            <span className="badge" style={{
                              fontSize: '0.7rem',
                              backgroundColor: h.source === 'demat' ? '#f3e8ff' : '#ccfbf1',
                              color: h.source === 'demat' ? '#7c3aed' : '#0f766e',
                            }}>
                              {h.source === 'demat' ? 'Demat' : 'RTA'}
                            </span>,
                            h.units?.toLocaleString('en-IN', { maximumFractionDigits: 4 }),
                            formatCurrency(h.nav || h.price),
                            formatCurrency(h.value),
                          ]}
                        />
                      )}

                      {/* Import Bar */}
                      <div className="bg-light border rounded p-2 mt-3 d-flex align-items-center justify-content-between">
                        <div className="small text-muted">
                          <strong>{casTotalSelected}</strong> of {casPreview.mutualFunds.length} mutual funds selected
                        </div>
                        <div className="d-flex gap-2">
                          <Button size="sm" variant="outline-secondary" onClick={handleCASReset}>
                            Cancel
                          </Button>
                          <Button
                            size="sm" variant="success"
                            onClick={handleCASImport}
                            disabled={casImporting || casTotalSelected === 0}
                          >
                            {casImporting ? (
                              <><Spinner size="sm" className="me-1" /> Importing...</>
                            ) : (
                              <><CheckCircle size={14} className="me-1" /> Import {casTotalSelected} Mutual Funds</>
                            )}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </Card.Body>
              </div>
            </Collapse>
          </Card>

          {/* Add Mutual Funds Manually */}
          <Card className="shadow-sm">
            <Card.Header
              className="d-flex align-items-center gap-2 bg-white py-2 px-3"
              style={{ cursor: 'pointer' }}
              onClick={() => toggleSection('mf-manual')}
            >
              <Search size={20} className="text-primary" />
              <span className="h6 fw-semibold mb-0 flex-grow-1">Add Mutual Funds Manually</span>
              <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                style={{ transition: 'transform 0.2s', transform: expandedSection === 'mf-manual' ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </Card.Header>
            <Collapse in={expandedSection === 'mf-manual'}>
              <div>
                <Card.Body className="pt-2">
                  <p className="small text-muted mb-3">Select a fund and enter the transaction details.</p>

                  {/* Transaction Type */}
                  <div className="d-flex align-items-center gap-3 mb-3 flex-wrap">
                    <span className="small fw-medium text-muted">Transaction Type</span>
                    {['Buy', 'Sell', 'SIP', 'SWP', 'STP', 'Switch'].map((label) => (
                      <Form.Check
                        key={label}
                        inline
                        type="radio"
                        name="mfTxnLabel"
                        id={`mf-txn-${label}`}
                        label={label}
                        checked={mfTxnLabel === label}
                        onChange={() => setMfTxnLabel(label)}
                        className="small"
                      />
                    ))}
                  </div>

                  <hr className="my-3" />

                  {/* Scheme Name + Folio */}
                  <Row className="g-3 mb-3">
                    <Col md={8}>
                      <Form.Label className="small text-muted" style={{ fontSize: '0.7rem' }}>Scheme Name</Form.Label>
                      <div className="position-relative">
                        <div className="d-flex gap-2">
                          <div className="position-relative flex-grow-1">
                            <Search size={14} className="position-absolute text-muted" style={{ left: 10, top: '50%', transform: 'translateY(-50%)' }} />
                            <Form.Control
                              size="sm"
                              type="text"
                              value={mfSearch}
                              onChange={(e) => { setMfSearch(e.target.value); if (e.target.value.length >= 3) handleMfSearch(); }}
                              onKeyDown={(e) => e.key === 'Enter' && handleMfSearch()}
                              placeholder="Search Scheme"
                              style={{ paddingLeft: 32 }}
                            />
                          </div>
                        </div>
                        {searching && <div className="small text-muted mt-1">Searching...</div>}
                        {mfResults.length > 0 && (
                          <div className="border rounded mt-1 bg-white shadow-sm position-absolute w-100" style={{ maxHeight: 240, overflowY: 'auto', zIndex: 10 }}>
                            {mfResults.map((mf) => (
                              <button
                                key={mf.schemeCode}
                                onClick={() => selectMf(mf)}
                                className="w-100 text-start px-3 py-2 small border-bottom bg-transparent border-0"
                                style={{ cursor: 'pointer' }}
                                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#eff6ff'}
                                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                              >
                                <div className="fw-medium">{mf.schemeName}</div>
                                <div className="text-muted" style={{ fontSize: '0.7rem' }}>Code: {mf.schemeCode}</div>
                              </button>
                            ))}
                          </div>
                        )}
                        {form.name && mfResults.length === 0 && !searching && (
                          <div className="mt-1 small text-success d-flex align-items-center gap-1">
                            <CheckCircle size={12} /> {form.name}
                          </div>
                        )}
                      </div>
                    </Col>
                    <Col md={4}>
                      <Form.Label className="small text-muted" style={{ fontSize: '0.7rem' }}>Folio No.</Form.Label>
                      <Form.Control
                        size="sm"
                        type="text"
                        value={form.folio_number}
                        onChange={(e) => setForm({ ...form, folio_number: e.target.value })}
                        placeholder="Folio No."
                      />
                    </Col>
                  </Row>

                  {/* Date + Amount */}
                  <Row className="g-3 mb-3">
                    <Col md={6}>
                      <Form.Label className="small text-muted" style={{ fontSize: '0.7rem' }}>Date of Investment</Form.Label>
                      <Form.Control
                        size="sm"
                        type="date"
                        value={txn.transaction_date}
                        onChange={(e) => updateTxn('transaction_date', e.target.value)}
                      />
                    </Col>
                    <Col md={6}>
                      <Form.Label className="small text-muted" style={{ fontSize: '0.7rem' }}>
                        {mfAmountMode === 'rupees' ? 'Amount in \u20b9' : 'Units'}
                      </Form.Label>
                      <Form.Control
                        size="sm"
                        type="number"
                        step={mfAmountMode === 'rupees' ? '0.01' : '0.001'}
                        value={mfAmountMode === 'rupees' ? txn.amount : txn.units}
                        onChange={(e) => mfAmountMode === 'rupees'
                          ? updateTxn('amount', e.target.value)
                          : updateTxn('units', e.target.value)
                        }
                        placeholder={mfAmountMode === 'rupees' ? 'Amount In \u20b9' : 'No. of units'}
                      />
                      <div className="d-flex gap-3 mt-1">
                        <Form.Check
                          inline type="radio" name="mfAmountMode" id="mf-mode-rupees"
                          label="Rupees" className="small"
                          checked={mfAmountMode === 'rupees'}
                          onChange={() => setMfAmountMode('rupees')}
                        />
                        <Form.Check
                          inline type="radio" name="mfAmountMode" id="mf-mode-units"
                          label="Units" className="small"
                          checked={mfAmountMode === 'units'}
                          onChange={() => setMfAmountMode('units')}
                        />
                      </div>
                    </Col>
                  </Row>

                  {/* NAV + Broker */}
                  <Row className="g-3 mb-3">
                    <Col md={6}>
                      <Form.Label className="small text-muted" style={{ fontSize: '0.7rem' }}>NAV (Price)</Form.Label>
                      <Form.Control
                        size="sm"
                        type="number"
                        step="0.0001"
                        value={txn.price_per_unit}
                        onChange={(e) => updateTxn('price_per_unit', e.target.value)}
                        placeholder="NAV at transaction"
                      />
                    </Col>
                    <Col md={6}>
                      <Form.Label className="small text-muted" style={{ fontSize: '0.7rem' }}>Broker / Platform</Form.Label>
                      <Form.Select
                        size="sm"
                        value={mfBroker}
                        onChange={(e) => setMfBroker(e.target.value)}
                      >
                        <option value="">Select broker...</option>
                        <option value="CAMS">CAMS</option>
                        <option value="KFintech">KFintech</option>
                        <option value="MFCentral">MFCentral</option>
                        <option value="Coin (Zerodha)">Coin (Zerodha)</option>
                        <option value="Groww">Groww</option>
                        <option value="Kuvera">Kuvera</option>
                        <option value="Paytm Money">Paytm Money</option>
                        <option value="MFUtility">MFUtility</option>
                        {brokerOptions.map(b => (
                          <option key={b.value} value={b.value}>{b.label}</option>
                        ))}
                      </Form.Select>
                    </Col>
                  </Row>

                  {/* Notes */}
                  <Row className="g-3 mb-3">
                    <Col md={12}>
                      <Form.Label className="small text-muted" style={{ fontSize: '0.7rem' }}>Notes / Remarks</Form.Label>
                      <Form.Control
                        size="sm"
                        type="text"
                        value={mfNotes}
                        onChange={(e) => setMfNotes(e.target.value)}
                        placeholder="Optional"
                      />
                    </Col>
                  </Row>

                  <hr className="my-3" />

                  <div className="d-flex justify-content-center gap-3">
                    <Button variant="primary" onClick={handleMfSubmit} disabled={submitting}>
                      {submitting ? <><Spinner size="sm" className="me-1" /> Adding...</> : '+ Add Transaction'}
                    </Button>
                    <Button variant="link" className="text-muted" onClick={() => navigate(-1)}>
                      Close
                    </Button>
                  </div>
                </Card.Body>
              </div>
            </Collapse>
          </Card>
        </>
      )}

      {/* PPF / SSY: collapsible upload + manual */}
      {(assetType === 'PPF' || assetType === 'SSY') && (
        <>
          {/* Upload PPF/SSY Statements */}
          <Card className="shadow-sm">
            <Card.Header
              className="d-flex align-items-center gap-2 bg-white py-2 px-3"
              style={{ cursor: 'pointer' }}
              onClick={() => toggleSection('ppf-upload')}
            >
              <Upload size={20} className="text-primary" />
              <span className="h6 fw-semibold mb-0 flex-grow-1">Upload {assetType} Statements</span>
              <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                style={{ transition: 'transform 0.2s', transform: expandedSection === 'ppf-upload' ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </Card.Header>
            <Collapse in={expandedSection === 'ppf-upload'}>
              <div>
                <Card.Body className="pt-2">
                  <p className="small text-muted mb-3">
                    Upload {assetType} account statement PDFs (SBI passbook format). Multiple year statements can be uploaded together.
                  </p>

                  {ppfError && (
                    <Alert variant="danger" className="small py-2 d-flex align-items-center gap-2">
                      <AlertCircle size={14} className="flex-shrink-0" />
                      {ppfError}
                    </Alert>
                  )}

                  {ppfResult && (
                    <Alert variant="success" className="small py-2">
                      <CheckCircle size={14} className="me-1" />
                      Imported {ppfResult.imported} transaction{ppfResult.imported !== 1 ? 's' : ''}.
                      {ppfResult.skipped > 0 && <span className="text-muted ms-1">({ppfResult.skipped} duplicates skipped)</span>}
                      <button className="btn btn-link btn-sm p-0 ms-2" onClick={handlePPFReset}>Upload more</button>
                    </Alert>
                  )}

                  {!ppfPreview && !ppfResult && (
                    <>
                      <Row className="g-3 align-items-end">
                        <Col md={12}>
                          <Form.Label className="small">Statement Files (PDF)</Form.Label>
                          <Form.Control
                            ref={ppfFileRef}
                            size="sm"
                            type="file"
                            accept=".pdf"
                            multiple
                            onChange={(e) => setPpfFiles(Array.from(e.target.files))}
                          />
                        </Col>
                      </Row>
                      <Row className="g-3 mt-0">
                        <Col md={6}>
                          <Form.Label className="small">PDF Password <span className="text-muted">(if protected)</span></Form.Label>
                          <Form.Control
                            size="sm"
                            type="password"
                            placeholder="Enter PDF password"
                            value={ppfPassword}
                            onChange={(e) => setPpfPassword(e.target.value)}
                          />
                        </Col>
                      </Row>
                      {ppfFiles.length > 0 && (
                        <div className="mt-2 small text-muted">
                          {ppfFiles.length} file{ppfFiles.length > 1 ? 's' : ''} selected
                        </div>
                      )}
                      <div className="mt-3">
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={handlePPFUpload}
                          disabled={ppfUploading || !ppfFiles.length}
                        >
                          {ppfUploading ? <><Spinner size="sm" className="me-1" /> Parsing...</> : <><Upload size={14} className="me-1" /> Parse & Preview</>}
                        </Button>
                      </div>
                    </>
                  )}

                  {/* PPF Preview */}
                  {ppfPreview && (
                    <div className="mt-3">
                      <div className="d-flex align-items-center gap-2 mb-2 flex-wrap">
                        <span className={`badge ${ppfPreview.accountType === 'SSY' ? 'bg-pink' : 'bg-warning text-dark'}`} style={ppfPreview.accountType === 'SSY' ? { backgroundColor: '#ec4899', color: '#fff' } : undefined}>
                          {ppfPreview.accountType}
                        </span>
                        {ppfPreview.accountNumber && <span className="badge bg-secondary">A/c: {ppfPreview.accountNumber}</span>}
                        {ppfPreview.accountName && <span className="badge bg-secondary">{ppfPreview.accountName}</span>}
                        {ppfPreview.interestRate && <span className="badge bg-info">{ppfPreview.interestRate}% p.a.</span>}
                        {ppfPreview.isNew && <span className="badge" style={{ fontSize: '0.6rem', backgroundColor: '#dbeafe', color: '#1d4ed8' }}>New Investment</span>}
                      </div>

                      <div className="small text-muted mb-2">
                        {ppfPreview.openDate && <span>Opened: {ppfPreview.openDate}</span>}
                        {ppfPreview.maturityDate && <span className="ms-3">Matures: {ppfPreview.maturityDate}</span>}
                      </div>

                      <div className="small mb-2">
                        <span className="text-success fw-medium">{ppfPreview.summary.newTransactions} new</span>
                        {ppfPreview.summary.existingTransactions > 0 && <span className="text-muted"> · {ppfPreview.summary.existingTransactions} already in DB</span>}
                        <span className="text-muted"> · {ppfPreview.summary.totalTransactions} total</span>
                      </div>

                      {/* Transaction Table */}
                      <div className="border rounded overflow-hidden">
                        <button
                          onClick={() => setPpfShowTxns(!ppfShowTxns)}
                          className="w-100 bg-transparent border-0 text-start px-3 py-2 d-flex align-items-center"
                          style={{ cursor: 'pointer' }}
                        >
                          <span className="small fw-medium flex-grow-1">Transactions ({ppfPreview.transactions.length})</span>
                          <ChevronDown size={14} className="text-muted" style={{ transition: 'transform 0.2s', transform: ppfShowTxns ? 'rotate(180deg)' : 'rotate(0deg)' }} />
                        </button>
                        {ppfShowTxns && (
                          <div className="border-top">
                            <div className="table-responsive" style={{ maxHeight: 350, overflowY: 'auto' }}>
                              <Table size="sm" className="mb-0" style={{ fontSize: '0.75rem' }}>
                                <thead className="table-light">
                                  <tr>
                                    <th className="px-2 py-1">Date</th>
                                    <th className="px-2 py-1">Type</th>
                                    <th className="px-2 py-1 text-end">Amount</th>
                                    <th className="px-2 py-1 text-end">Balance</th>
                                    <th className="px-2 py-1">Description</th>
                                    <th className="px-2 py-1">Status</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {ppfPreview.transactions.map((t, ti) => (
                                    <tr key={ti} style={{ opacity: t.isNew ? 1 : 0.5 }}>
                                      <td className="px-2 py-1 text-nowrap">{t.date}</td>
                                      <td className="px-2 py-1">
                                        <span className={`badge ${PPF_TYPE_COLORS[t.type] || 'bg-secondary'}`} style={{ fontSize: '0.65rem' }}>
                                          {t.type}
                                        </span>
                                      </td>
                                      <td className="px-2 py-1 text-end">{formatCurrency(t.amount)}</td>
                                      <td className="px-2 py-1 text-end">{formatCurrency(t.balance)}</td>
                                      <td className="px-2 py-1 text-muted text-truncate" style={{ maxWidth: 200 }}>{t.description}</td>
                                      <td className="px-2 py-1">
                                        {t.isNew ? (
                                          <span className="badge" style={{ fontSize: '0.6rem', backgroundColor: '#dcfce7', color: '#15803d' }}>New</span>
                                        ) : (
                                          <span className="badge bg-light text-muted" style={{ fontSize: '0.6rem' }}>In DB</span>
                                        )}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </Table>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Import Bar */}
                      <div className="bg-light border rounded p-2 mt-3 d-flex align-items-center justify-content-between">
                        <div className="small text-muted">
                          <strong>{ppfPreview.summary.newTransactions}</strong> new transactions to import
                        </div>
                        <div className="d-flex gap-2">
                          <Button size="sm" variant="outline-secondary" onClick={handlePPFReset}>Cancel</Button>
                          <Button
                            size="sm" variant="success"
                            onClick={handlePPFImport}
                            disabled={ppfImporting || ppfPreview.summary.newTransactions === 0}
                          >
                            {ppfImporting ? <><Spinner size="sm" className="me-1" /> Importing...</> : <><CheckCircle size={14} className="me-1" /> Approve & Import</>}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </Card.Body>
              </div>
            </Collapse>
          </Card>

          {/* Add PPF/SSY Manually */}
          <Card className="shadow-sm">
            <Card.Header
              className="d-flex align-items-center gap-2 bg-white py-2 px-3"
              style={{ cursor: 'pointer' }}
              onClick={() => toggleSection('ppf-manual')}
            >
              <Search size={20} className="text-primary" />
              <span className="h6 fw-semibold mb-0 flex-grow-1">Add {assetType} Manually</span>
              <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                style={{ transition: 'transform 0.2s', transform: expandedSection === 'ppf-manual' ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </Card.Header>
            <Collapse in={expandedSection === 'ppf-manual'}>
              <div>
                <Card.Body className="pt-2">
                  <p className="small text-muted mb-3">Select an existing {assetType} account or create a new one, then add a transaction.</p>

                  <Row className="g-3">
                    <Col md={12}>
                      <Form.Label className="small">Account</Form.Label>
                      <Form.Select
                        size="sm"
                        value={selectedPpfAccount}
                        onChange={(e) => {
                          setSelectedPpfAccount(e.target.value);
                          if (e.target.value) {
                            const acct = ppfAccounts.find(a => a.id === parseInt(e.target.value));
                            if (acct) setForm({ ...form, name: acct.name, account_number: acct.account_number || '' });
                          } else {
                            setForm({ ...form, name: '', account_number: '' });
                          }
                        }}
                      >
                        <option value="">+ Create New Account</option>
                        {ppfAccounts.map(acct => (
                          <option key={acct.id} value={acct.id}>
                            {acct.name}{acct.account_number ? ` (${acct.account_number})` : ''}
                          </option>
                        ))}
                      </Form.Select>
                    </Col>
                  </Row>

                  {/* New account fields - only when creating */}
                  {!selectedPpfAccount && (
                    <Row className="g-3 mt-1">
                      <Col md={6}>
                        <Form.Label className="small">Account Name</Form.Label>
                        <Form.Control
                          size="sm"
                          type="text"
                          value={form.name}
                          onChange={(e) => setForm({ ...form, name: e.target.value })}
                          placeholder={`e.g., ${assetType} - Pankaj Yadav`}
                          required
                        />
                      </Col>
                      <Col md={6}>
                        <Form.Label className="small">Account Number</Form.Label>
                        <Form.Control
                          size="sm"
                          type="text"
                          value={form.account_number}
                          onChange={(e) => setForm({ ...form, account_number: e.target.value })}
                          placeholder="Account number"
                        />
                      </Col>
                    </Row>
                  )}

                  <hr className="my-3" />
                  <h6 className="small fw-semibold mb-2">Transaction {!selectedPpfAccount && <span className="fw-normal text-muted">(optional)</span>}</h6>

                  <Row className="g-3">
                    <Col md={6}>
                      <Form.Label className="small">Type</Form.Label>
                      <Form.Select
                        size="sm"
                        value={txn.transaction_type}
                        onChange={(e) => updateTxn('transaction_type', e.target.value)}
                      >
                        <option value="DEPOSIT">Deposit</option>
                        <option value="WITHDRAWAL">Withdrawal</option>
                        <option value="INTEREST">Interest</option>
                        <option value="RECONCILE">Reconcile</option>
                      </Form.Select>
                    </Col>
                    <Col md={6}>
                      <Form.Label className="small">Date</Form.Label>
                      <Form.Control
                        size="sm"
                        type="date"
                        value={txn.transaction_date}
                        onChange={(e) => updateTxn('transaction_date', e.target.value)}
                      />
                    </Col>
                    <Col md={6}>
                      <Form.Label className="small">Amount (₹)</Form.Label>
                      <Form.Control
                        size="sm"
                        type="number"
                        step="0.01"
                        value={txn.amount}
                        onChange={(e) => updateTxn('amount', e.target.value)}
                        placeholder="Deposit amount"
                      />
                    </Col>
                    <Col md={12}>
                      <Form.Label className="small">Notes</Form.Label>
                      <Form.Control
                        size="sm"
                        type="text"
                        value={txn.notes || ''}
                        onChange={(e) => setTxn({ ...txn, notes: e.target.value })}
                        placeholder="Optional transaction notes"
                      />
                    </Col>
                  </Row>

                  <div className="mt-3 d-flex justify-content-center gap-3">
                    <Button variant="primary" onClick={handleSubmit} disabled={submitting}>
                      {submitting ? <><Spinner size="sm" className="me-1" /> Adding...</> : selectedPpfAccount ? `+ Add Transaction` : `+ Add ${assetType} Investment`}
                    </Button>
                    <Button variant="link" className="text-muted" onClick={() => navigate(-1)}>
                      Close
                    </Button>
                  </div>
                </Card.Body>
              </div>
            </Collapse>
          </Card>
        </>
      )}

      {/* PF: Upload + Manual sections */}
      {assetType === 'PF' && (
        <>
          {/* Upload PF Statements */}
          <Card className="shadow-sm">
            <Card.Header
              className="d-flex align-items-center gap-2 bg-white py-2 px-3"
              style={{ cursor: 'pointer' }}
              onClick={() => toggleSection('pf-upload')}
            >
              <Upload size={20} className="text-primary" />
              <span className="h6 fw-semibold mb-0 flex-grow-1">Upload PF Statements</span>
              <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                style={{ transition: 'transform 0.2s', transform: expandedSection === 'pf-upload' ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </Card.Header>
            <Collapse in={expandedSection === 'pf-upload'}>
              <div>
                <Card.Body className="pt-2">
                  <p className="small text-muted mb-3">
                    Upload EPFO Member Passbook PDFs (FY 2020-21 onwards). Multiple year statements can be uploaded together.
                  </p>

                  {pfError && (
                    <Alert variant="danger" className="small py-2 d-flex align-items-center gap-2">
                      <AlertCircle size={14} className="flex-shrink-0" />
                      {pfError}
                    </Alert>
                  )}

                  {pfResult && (
                    <Alert variant="success" className="small py-2">
                      <CheckCircle size={14} className="me-1" />
                      Imported {pfResult.imported} transaction{pfResult.imported !== 1 ? 's' : ''}.
                      {pfResult.skipped > 0 && <span className="text-muted ms-1">({pfResult.skipped} duplicates skipped)</span>}
                      <button className="btn btn-link btn-sm p-0 ms-2" onClick={handlePFReset}>Upload more</button>
                    </Alert>
                  )}

                  {!pfPreview && !pfResult && (
                    <>
                      <Row className="g-3 align-items-end">
                        <Col md={12}>
                          <Form.Label className="small">Statement Files (PDF)</Form.Label>
                          <Form.Control
                            ref={pfFileRef}
                            size="sm"
                            type="file"
                            accept=".pdf"
                            multiple
                            onChange={(e) => setPfFiles(Array.from(e.target.files))}
                          />
                        </Col>
                      </Row>
                      {pfFiles.length > 0 && (
                        <div className="mt-2 small text-muted">
                          {pfFiles.length} file{pfFiles.length > 1 ? 's' : ''} selected
                        </div>
                      )}
                      <div className="mt-3">
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={handlePFUpload}
                          disabled={pfUploading || !pfFiles.length}
                        >
                          {pfUploading ? <><Spinner size="sm" className="me-1" /> Parsing...</> : <><Upload size={14} className="me-1" /> Parse & Preview</>}
                        </Button>
                      </div>
                    </>
                  )}

                  {/* PF Preview */}
                  {pfPreview && (
                    <div className="mt-3">
                      <div className="d-flex align-items-center gap-2 mb-2 flex-wrap">
                        <span className="badge bg-info">PF</span>
                        {pfPreview.uan && <span className="badge bg-secondary">UAN: {pfPreview.uan}</span>}
                        {pfPreview.memberName && <span className="badge bg-secondary">{pfPreview.memberName}</span>}
                        {pfPreview.pfInvestmentId && <span className="badge" style={{ fontSize: '0.6rem', backgroundColor: '#dbeafe', color: '#1d4ed8' }}>Existing Investment</span>}
                      </div>

                      <div className="small mb-2">
                        <span className="text-success fw-medium">{pfPreview.summary.newTransactions} new</span>
                        {pfPreview.summary.existingTransactions > 0 && <span className="text-muted"> · {pfPreview.summary.existingTransactions} already in DB</span>}
                        <span className="text-muted"> · {pfPreview.summary.totalTransactions} total</span>
                      </div>

                      {/* Transaction Table with Select/Deselect */}
                      <div className="border rounded overflow-hidden">
                        <button
                          onClick={() => setPfShowTxns(!pfShowTxns)}
                          className="w-100 bg-transparent border-0 text-start px-3 py-2 d-flex align-items-center"
                          style={{ cursor: 'pointer' }}
                        >
                          <span className="small fw-medium flex-grow-1">Transactions ({pfPreview.transactions.length})</span>
                          <ChevronDown size={14} className="text-muted" style={{ transition: 'transform 0.2s', transform: pfShowTxns ? 'rotate(180deg)' : 'rotate(0deg)' }} />
                        </button>
                        {pfShowTxns && (
                          <div className="border-top">
                            <div className="table-responsive" style={{ maxHeight: 350, overflowY: 'auto' }}>
                              <Table size="sm" className="mb-0" style={{ fontSize: '0.75rem' }}>
                                <thead className="table-light">
                                  <tr>
                                    <th className="px-2 py-1 text-center" style={{ width: '30px' }}>Select</th>
                                    <th className="px-2 py-1">Date</th>
                                    <th className="px-2 py-1">Type</th>
                                    <th className="px-2 py-1 text-end">Amount</th>
                                    <th className="px-2 py-1">Status</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {pfPreview.transactions.map((t, ti) => (
                                    <tr key={ti} style={{ opacity: t.isNew ? 1 : 0.5, backgroundColor: pfSelectedTxns.has(ti) ? '#f0f7ff' : 'transparent' }}>
                                      <td className="px-2 py-1 text-center">
                                        <Form.Check
                                          type="checkbox"
                                          checked={pfSelectedTxns.has(ti)}
                                          onChange={() => togglePFTransaction(ti)}
                                          disabled={!t.isNew}
                                        />
                                      </td>
                                      <td className="px-2 py-1 text-nowrap">{t.date}</td>
                                      <td className="px-2 py-1">
                                        <span className={`badge ${PF_TYPE_COLORS[t.type] || 'bg-secondary'}`} style={{ fontSize: '0.65rem' }}>
                                          {t.type}
                                        </span>
                                      </td>
                                      <td className="px-2 py-1 text-end">{formatCurrency(t.amount)}</td>
                                      <td className="px-2 py-1">
                                        {t.isNew ? (
                                          <span className="badge" style={{ fontSize: '0.6rem', backgroundColor: '#dcfce7', color: '#15803d' }}>New</span>
                                        ) : (
                                          <span className="badge bg-light text-muted" style={{ fontSize: '0.6rem' }}>In DB</span>
                                        )}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </Table>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Import Bar */}
                      <div className="bg-light border rounded p-2 mt-3 d-flex align-items-center justify-content-between">
                        <div className="small text-muted">
                          <strong>{pfSelectedTxns.size}</strong> transaction{pfSelectedTxns.size !== 1 ? 's' : ''} selected to import
                        </div>
                        <div className="d-flex gap-2">
                          <Button size="sm" variant="outline-secondary" onClick={handlePFReset}>Cancel</Button>
                          <Button
                            size="sm" variant="success"
                            onClick={handlePFImport}
                            disabled={pfImporting || pfSelectedTxns.size === 0}
                          >
                            {pfImporting ? <><Spinner size="sm" className="me-1" /> Importing...</> : <><CheckCircle size={14} className="me-1" /> Approve & Import</>}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </Card.Body>
              </div>
            </Collapse>
          </Card>

          {/* Add PF Manually */}
          <Card className="shadow-sm">
            <Card.Header
              className="d-flex align-items-center gap-2 bg-white py-2 px-3"
              style={{ cursor: 'pointer' }}
              onClick={() => toggleSection('pf-manual')}
            >
              <Plus size={20} className="text-primary" />
              <span className="h6 fw-semibold mb-0 flex-grow-1">Add PF Manually</span>
              <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                style={{ transition: 'transform 0.2s', transform: expandedSection === 'pf-manual' ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </Card.Header>
            <Collapse in={expandedSection === 'pf-manual'}>
              <div>
                <Card.Body className="pt-2">
                  <p className="small text-muted mb-3">Add one PF row at a time. EPS is derived automatically from Employee and Employer contribution rows, so it is not entered here.</p>

                  {pfError && (
                    <Alert variant="danger" className="small py-2 d-flex align-items-center gap-2 mb-3">
                      <AlertCircle size={14} className="flex-shrink-0" />
                      {pfError}
                    </Alert>
                  )}

                  {pfResult && (
                    <Alert variant="success" className="small py-2 mb-3">
                      <CheckCircle size={14} className="me-1" />
                      Added {pfResult.inserted} transaction{pfResult.inserted !== 1 ? 's' : ''}
                      <button className="btn btn-link btn-sm p-0 ms-2" onClick={() => {
                        setPfResult(null);
                        setPfManualForm({
                          date: new Date().toISOString().split('T')[0],
                          type: 'DEPOSIT',
                              amount: '',
                          notes: '',
                        });
                      }}>Add another</button>
                    </Alert>
                  )}

                  {!pfResult && (
                    <>
                      <Row className="g-3">
                        <Col md={6}>
                          <Form.Label className="small">Date</Form.Label>
                          <Form.Control
                            size="sm"
                            type="date"
                            value={pfManualForm.date}
                            onChange={(e) => setPfManualForm({ ...pfManualForm, date: e.target.value })}
                          />
                        </Col>
                        <Col md={6}>
                          <Form.Label className="small">Transaction Type</Form.Label>
                          <Form.Select
                            size="sm"
                            value={pfManualForm.type}
                            onChange={(e) => setPfManualForm({ ...pfManualForm, type: e.target.value })}
                          >
                                {PF_MANUAL_TYPES.map((item) => (
                                  <option key={item.value} value={item.value}>{item.label}</option>
                                ))}
                          </Form.Select>
                        </Col>
                        <Col md={6}>
                              <Form.Label className="small">{pfManualTypeMeta.amountLabel} (₹)</Form.Label>
                          <Form.Control
                            size="sm"
                            type="number"
                            step="0.01"
                                value={pfManualForm.amount}
                                onChange={(e) => setPfManualForm({ ...pfManualForm, amount: e.target.value })}
                                placeholder={pfManualTypeMeta.amountLabel}
                          />
                        </Col>
                        <Col md={12}>
                          <Form.Label className="small">Notes</Form.Label>
                          <Form.Control
                            size="sm"
                            type="text"
                            value={pfManualForm.notes || ''}
                            onChange={(e) => setPfManualForm({ ...pfManualForm, notes: e.target.value })}
                            placeholder="Optional notes"
                          />
                        </Col>
                            <Col md={12}>
                              <div className="small text-muted mt-1">This will create a single PF transaction row. Use the same date for related contribution rows if you want them grouped in the table.</div>
                            </Col>
                      </Row>

                      <div className="mt-3 d-flex justify-content-center gap-3">
                        <Button
                          variant="primary"
                          onClick={handlePFManualSubmit}
                          disabled={pfImporting}
                        >
                          {pfImporting ? <><Spinner size="sm" className="me-1" /> Adding...</> : <><Plus size={14} className="me-1" /> Add Transaction</>}
                        </Button>
                        <Button variant="link" className="text-muted" onClick={() => navigate(-1)}>
                          Close
                        </Button>
                      </div>
                    </>
                  )}
                </Card.Body>
              </div>
            </Collapse>
          </Card>
        </>
      )}

      {/* Non-Indian-Stock / Non-Bond / Non-SGB / Non-MF / Non-NPS / Non-PPF / Non-SSY / Non-PF: original flow */}
      {!isIndianStock && !isBond && !isSGB && !isMF && !isNPS && assetType !== 'PPF' && assetType !== 'SSY' && assetType !== 'PF' && (
        <>
          {isForeignStock && (
            <Card className="shadow-sm">
              <Card.Header
                className="d-flex align-items-center gap-2 bg-white py-2 px-3"
                style={{ cursor: 'pointer' }}
                onClick={() => toggleSection('rsu-grant')}
              >
                <Upload size={20} className="text-primary" />
                <span className="h6 fw-semibold mb-0 flex-grow-1">Upload Stock Grant Documents (RSU)</span>
                <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                  style={{ transition: 'transform 0.2s', transform: expandedSection === 'rsu-grant' ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </Card.Header>
              <Collapse in={expandedSection === 'rsu-grant'}>
                <Card.Body>
                <p className="small text-muted mb-3">
                  Upload annual/on-hire/special grant files. The app maps award numbers, creates the Foreign Stock investment,
                  and imports VEST transactions automatically. Exchange rates are fetched automatically.
                </p>

                <Form.Label className="small">Grant Document Files</Form.Label>
                <Form.Control
                  ref={rsuGrantFileRef}
                  size="sm"
                  type="file"
                  accept=".doc,.docx,.htm,.html,.txt"
                  multiple
                  onChange={(e) => {
                    setRsuGrantFiles(Array.from(e.target.files || []));
                    setRsuGrantPreview(null);
                  }}
                />
                {rsuGrantFiles.length > 0 && (
                  <div className="small text-muted mt-2">
                    Selected {rsuGrantFiles.length} file(s)
                  </div>
                )}

                <div className="d-flex flex-wrap gap-2 mt-3">
                  <Button size="sm" variant="outline-primary" onClick={handleRsuGrantPreview} disabled={rsuParsing || rsuCreating || !rsuGrantFiles.length}>
                    {rsuParsing ? <><Spinner size="sm" className="me-1" /> Parsing...</> : 'Preview Grants from Docs'}
                  </Button>
                  <Button size="sm" variant="outline-secondary" onClick={handleRsuGrantReset} disabled={rsuParsing || rsuCreating}>
                    Reset
                  </Button>
                </div>

                {rsuGrantPreview && (
                  <div className="mt-3 border rounded p-2 bg-light">
                    <div className="small mb-2">
                      <strong>Matched Grants:</strong> {rsuGrantPreview.matched_count || 0}
                    </div>
                    {!!rsuGrantPreview.matched_grants?.length && (
                      <div className="small mb-2">
                        {rsuGrantPreview.matched_grants.map((g) => (
                          <div key={g.key}>• {g.label} | Award {g.award_number} | Shares {g.total_shares}</div>
                        ))}
                      </div>
                    )}

                    <div className="d-flex flex-wrap gap-3 mt-2">
                      <Form.Check
                        type="switch"
                        id="rsu-include-future-add"
                        label="Include future vest dates"
                        checked={rsuIncludeFuture}
                        onChange={(e) => setRsuIncludeFuture(e.target.checked)}
                      />
                      <Form.Check
                        type="switch"
                        id="rsu-overwrite-add"
                        label="Replace existing imported rows (selected grants only)"
                        checked={rsuOverwriteExisting}
                        onChange={(e) => setRsuOverwriteExisting(e.target.checked)}
                      />
                    </div>

                    <div className="small text-muted mt-2">
                      If a matching stock investment already exists, this will import into that investment instead of creating a duplicate.
                    </div>

                    <Button
                      size="sm"
                      className="mt-3"
                      variant="primary"
                      onClick={handleCreateFromRsuDocs}
                      disabled={rsuCreating || rsuParsing || !rsuGrantPreview.grant_keys?.length}
                    >
                      {rsuCreating ? <><Spinner size="sm" className="me-1" /> Importing RSU Grants...</> : 'Import RSU Grants'}
                    </Button>
                  </div>
                )}
                </Card.Body>
              </Collapse>
            </Card>
          )}

          {isForeignStock && (
            <Card className="shadow-sm">
              <Card.Header
                className="d-flex align-items-center gap-2 bg-white py-2 px-3"
                style={{ cursor: 'pointer' }}
                onClick={() => toggleSection('fidelity-confirmations')}
              >
                <FileText size={20} className="text-primary" />
                <span className="h6 fw-semibold mb-0 flex-grow-1">Upload Fidelity Trade Confirmations</span>
                {expandedSection === 'fidelity-confirmations' ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
              </Card.Header>
              <Collapse in={expandedSection === 'fidelity-confirmations'}>
                <Card.Body>
                  <Form.Label className="small">Trade Confirmation PDFs</Form.Label>
                  <Form.Control
                    ref={fidelityFileRef}
                    size="sm"
                    type="file"
                    accept=".pdf,application/pdf"
                    multiple
                    onChange={(e) => {
                      setFidelityFiles(Array.from(e.target.files || []));
                      setFidelityPreview(null);
                      setFidelityResult(null);
                    }}
                  />
                  {fidelityFiles.length > 0 && (
                    <div className="small text-muted mt-2">Selected {fidelityFiles.length} file(s)</div>
                  )}

                  <div className="d-flex flex-wrap gap-2 mt-3">
                    <Button size="sm" variant="outline-primary" onClick={handleFidelityPreview} disabled={fidelityParsing || fidelityImporting || !fidelityFiles.length}>
                      {fidelityParsing ? <><Spinner size="sm" className="me-1" /> Parsing...</> : 'Preview Confirmations'}
                    </Button>
                    <Button size="sm" variant="outline-secondary" onClick={handleFidelityReset} disabled={fidelityParsing || fidelityImporting}>
                      Reset
                    </Button>
                  </div>

                  {fidelityResult && (
                    <Alert variant="success" className="small py-2 mt-3 mb-0">
                      Imported {fidelityResult.transactionsCreated} and skipped {fidelityResult.transactionsSkipped} existing transaction(s).
                    </Alert>
                  )}

                  {fidelityPreview && (
                    <div className="mt-3">
                      <div className="small mb-2">
                        <strong>{fidelityPreview.filesProcessed} confirmation(s)</strong>
                        {' | '}Gross ${Number(fidelityPreview.summary.grossProceedsUsd).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                        {' | '}Fees ${Number(fidelityPreview.summary.totalFeesUsd).toFixed(2)}
                        {' | '}Net ${Number(fidelityPreview.summary.netProceedsUsd).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </div>
                      <div className="table-responsive">
                        <Table size="sm" bordered hover className="small mb-2">
                          <thead className="table-light">
                            <tr>
                              <th>Trade / Settlement</th><th>Security</th><th>Shares</th><th>Price</th>
                              <th>Gross</th><th>Fees</th><th>Net</th><th>Identifiers</th>
                            </tr>
                          </thead>
                          <tbody>
                            {fidelityPreview.trades.map((trade) => (
                              <tr key={`${trade.transactionNumber}-${trade.fileName}`}>
                                <td>{trade.tradeDate}<br /><span className="text-muted">{trade.settlementDate}</span></td>
                                <td><strong>{trade.ticker}</strong><br /><span className="text-muted">{trade.security}</span></td>
                                <td>{trade.quantity}</td>
                                <td>${Number(trade.rate).toFixed(4)}</td>
                                <td>${Number(trade.grossProceedsUsd).toFixed(2)}</td>
                                <td>${Number(trade.feesUsd).toFixed(2)}</td>
                                <td>${Number(trade.netProceedsUsd).toFixed(2)}</td>
                                <td>
                                  Txn {trade.transactionNumber}<br />Ref {trade.referenceNumber}<br />CUSIP {trade.cusip}
                                  <br /><span className="text-muted">Participant {trade.participantId} | Customer {trade.customerNumber}</span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </Table>
                      </div>
                      <Button size="sm" variant="primary" onClick={handleFidelityImport} disabled={fidelityImporting}>
                        {fidelityImporting ? <><Spinner size="sm" className="me-1" /> Importing...</> : 'Import Transactions'}
                      </Button>
                    </div>
                  )}
                </Card.Body>
              </Collapse>
            </Card>
          )}

          {/* Add Manual Foreign Stock Transaction */}
          {isForeignStock && (
            <Card className="shadow-sm">
              <Card.Header
                className="bg-light d-flex justify-content-between align-items-center"
                style={{ cursor: 'pointer' }}
                onClick={() => toggleSection('manual-foreign-stock')}
              >
                <div className="d-flex align-items-center gap-2">
                  <Search size={16} className="text-primary" />
                  <span className="fw-semibold small">Add Foreign Stocks Manually</span>
                </div>
                {expandedSection === 'manual-foreign-stock' ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
              </Card.Header>
              <Collapse in={expandedSection === 'manual-foreign-stock'}>
                <Card.Body>
                  <p className="small text-muted mb-3">Search for a stock and enter the transaction details.</p>

                  {/* Stock Search & Selection */}
                  <div className="mb-3">
                    <Form.Label className="small fw-semibold">Stock Name</Form.Label>
                    <div className="d-flex gap-2">
                      <Form.Control
                        size="sm"
                        type="text"
                        value={stockQuery}
                        onChange={(e) => { setStockQuery(e.target.value); setStockInfo(null); setStockResults([]); }}
                        onKeyDown={(e) => e.key === 'Enter' && handleStockSearch()}
                        placeholder="e.g., AAPL, Tesla, S&P 500 ETF"
                      />
                      <Button size="sm" variant="primary" onClick={handleStockSearch} disabled={searching}>
                        {searching ? <Spinner size="sm" animation="border" /> : <Search size={16} />}
                      </Button>
                    </div>
                    {stockResults.length > 0 && (
                      <div className="border rounded mt-2 bg-white shadow-sm" style={{ maxHeight: 200, overflowY: 'auto' }}>
                        {stockResults.map((r, i) => (
                          <div
                            key={i}
                            className="px-3 py-2 border-bottom small d-flex justify-content-between align-items-center"
                            style={{ cursor: 'pointer' }}
                            onClick={() => selectStock(r)}
                            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f0f0f0'}
                            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = ''}
                          >
                            <div>
                              <strong>{r.symbol}</strong>
                              <span className="text-muted ms-2">{r.name}</span>
                            </div>
                            <span className="badge bg-secondary">{r.type}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {stockInfo && (
                      <div className="mt-2 p-2 bg-success bg-opacity-10 rounded d-flex align-items-center gap-2">
                        <CheckCircle size={16} className="text-success" />
                        <span className="small text-success">
                          Found: <strong>{stockInfo.name}</strong> ({form.ticker_symbol}) — ${stockInfo.price?.toFixed(2)} ({stockInfo.currency})
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Transaction Details */}
                  <Row className="g-3 mb-3">
                    <Col md={6}>
                      <Form.Label className="small fw-semibold">Transaction Type</Form.Label>
                      <Form.Select
                        size="sm"
                        value={manualStockTxn.transaction_type}
                        onChange={(e) => updateManualStockTxn('transaction_type', e.target.value)}
                      >
                        <option value="BUY">Buy</option>
                        <option value="SELL">Sell</option>
                      </Form.Select>
                    </Col>
                    <Col md={6}>
                      <Form.Label className="small fw-semibold">Date of Transaction</Form.Label>
                      <Form.Control
                        size="sm"
                        type="date"
                        value={manualStockTxn.transaction_date}
                        onChange={(e) => updateManualStockTxn('transaction_date', e.target.value)}
                      />
                    </Col>
                    <Col md={6}>
                      <Form.Label className="small fw-semibold">No. of Units / Shares</Form.Label>
                      <Form.Control
                        size="sm"
                        type="number"
                        step="0.001"
                        value={manualStockTxn.units}
                        onChange={(e) => updateManualStockTxn('units', e.target.value)}
                        placeholder="Number of units"
                      />
                    </Col>
                    <Col md={6}>
                      <Form.Label className="small fw-semibold">Price per Unit (USD)</Form.Label>
                      <Form.Control
                        size="sm"
                        type="number"
                        step="0.0001"
                        value={manualStockTxn.price_per_unit}
                        onChange={(e) => updateManualStockTxn('price_per_unit', e.target.value)}
                        placeholder="Price per unit"
                      />
                    </Col>
                    <Col md={6}>
                      <Form.Label className="small fw-semibold">Total Amount (USD)</Form.Label>
                      <Form.Control
                        size="sm"
                        type="number"
                        step="0.01"
                        value={manualStockTxn.amount}
                        placeholder={manualStockTxn.units && manualStockTxn.price_per_unit ? `${(parseFloat(manualStockTxn.units) * parseFloat(manualStockTxn.price_per_unit)).toFixed(2)}` : 'Auto-calculated'}
                        disabled
                      />
                    </Col>
                    <Col md={6}>
                      <Form.Label className="small fw-semibold">Broker</Form.Label>
                      <Form.Control
                        size="sm"
                        type="text"
                        value={manualStockTxn.broker}
                        onChange={(e) => updateManualStockTxn('broker', e.target.value)}
                        placeholder="e.g., Fidelity, Interactive Brokers"
                      />
                    </Col>
                    <Col md={6}>
                      <Form.Label className="small fw-semibold">Fees (USD)</Form.Label>
                      <Form.Control
                        size="sm"
                        type="number"
                        step="0.01"
                        value={manualStockTxn.fees}
                        onChange={(e) => updateManualStockTxn('fees', e.target.value)}
                        placeholder="0"
                      />
                    </Col>

                    <Col md={12}>
                      <Form.Label className="small fw-semibold">Notes</Form.Label>
                      <Form.Control
                        size="sm"
                        type="text"
                        value={manualStockTxn.notes}
                        onChange={(e) => updateManualStockTxn('notes', e.target.value)}
                        placeholder="Optional notes"
                      />
                    </Col>
                  </Row>

                  <div className="d-flex gap-2">
                    <Button size="sm" variant="primary" onClick={handleAddManualStockTxn} disabled={addingManualTxn}>
                      {addingManualTxn ? 'Creating...' : 'Add Investment'}
                    </Button>
                    <Button size="sm" variant="outline-secondary" onClick={handleCancelManualStockTxn}>
                      Cancel
                    </Button>
                  </div>
                </Card.Body>
              </Collapse>
            </Card>
          )}

          {/* Submit */}
          <div className="d-flex justify-content-end gap-2">
            <Button variant="outline-secondary" onClick={() => navigate(-1)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Adding...' : 'Add Investment'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/* ─── CAS Holdings table (inline in AddInvestment) ─── */
function CASHoldingTable({ title, emoji, items, selected, setSelected, open, toggle, columns, renderRow }) {
  const allSelected = selected.size === items.length;
  const newCount = items.filter(h => h.isNew).length;
  const existingCount = items.length - newCount;

  return (
    <div className="border rounded mb-2 overflow-hidden">
      <button
        onClick={toggle}
        className="d-flex align-items-center justify-content-between w-100 px-3 py-2 bg-transparent border-0"
        style={{ cursor: 'pointer' }}
        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f8f9fa'}
        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
      >
        <div className="d-flex align-items-center gap-2">
          <span>{emoji}</span>
          <span className="small fw-semibold">{title}</span>
          <span className="small text-muted">({items.length})</span>
          {existingCount > 0 && (
            <span className="badge" style={{ fontSize: '0.65rem', backgroundColor: '#fef3c7', color: '#92400e' }}>
              {existingCount} already tracked
            </span>
          )}
        </div>
        <ChevronDown size={14} className="text-muted" style={{ transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }} />
      </button>

      {open && (
        <div className="border-top">
          <div className="table-responsive" style={{ maxHeight: 300, overflowY: 'auto' }}>
            <Table size="sm" className="mb-0 small">
              <thead className="table-light">
                <tr>
                  <th className="px-2 py-1" style={{ width: 32 }}>
                    <Form.Check
                      type="checkbox"
                      checked={allSelected}
                      onChange={() => {
                        if (allSelected) setSelected(new Set());
                        else setSelected(new Set(items.map((_, i) => i)));
                      }}
                    />
                  </th>
                  {columns.map((col, i) => (
                    <th key={i} className="px-2 py-1 text-muted" style={{ fontSize: '0.65rem' }}>
                      {col}
                    </th>
                  ))}
                  <th className="px-2 py-1 text-muted" style={{ fontSize: '0.65rem' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((h, idx) => {
                  const cells = renderRow(h);
                  return (
                    <tr
                      key={idx}
                      className={selected.has(idx) ? 'table-primary' : ''}
                      style={{ opacity: !h.isNew ? 0.75 : 1 }}
                    >
                      <td className="px-2 py-1">
                        <Form.Check
                          type="checkbox"
                          checked={selected.has(idx)}
                          onChange={() => {
                            const next = new Set(selected);
                            if (next.has(idx)) next.delete(idx);
                            else next.add(idx);
                            setSelected(next);
                          }}
                        />
                      </td>
                      {cells.map((cell, i) => (
                        <td key={i} className="px-2 py-1">{cell}</td>
                      ))}
                      <td className="px-2 py-1">
                        {h.isNew ? (
                          <span className="badge" style={{ fontSize: '0.65rem', backgroundColor: '#dcfce7', color: '#15803d' }}>New</span>
                        ) : (
                          <span className="badge bg-light text-muted" style={{ fontSize: '0.65rem' }} title={`Matches: ${h.existingName}`}>
                            Tracked
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── CAMS/KFintech CAS Preview (transaction-level delta) ─── */
function CAMSCASPreview({ preview, selectedSchemes, setSelectedSchemes, expandedScheme, setExpandedScheme, onImport, onCancel, importing, formatCurrency }) {
  const schemeHasChanges = (sc) => (sc.newTransactionCount > 0 || sc.updateTransactionCount > 0);
  const selectedNewTxns = preview.schemes
    .filter((_, i) => selectedSchemes.has(i))
    .reduce((s, sc) => s + sc.newTransactionCount, 0);
  const selectedUpdateTxns = preview.schemes
    .filter((_, i) => selectedSchemes.has(i))
    .reduce((s, sc) => s + (sc.updateTransactionCount || 0), 0);

  const allWithChanges = preview.schemes
    .map((s, i) => (schemeHasChanges(s) ? i : null))
    .filter(i => i !== null);
  const allSelected = allWithChanges.length > 0 && allWithChanges.every(i => selectedSchemes.has(i));

  return (
    <div className="mt-3">
      {/* Summary */}
      <div className="d-flex align-items-center gap-2 mb-2 flex-wrap">
        <span className="badge bg-info">CAMS/KFintech CAS</span>
        <span className="badge bg-secondary">{preview.investorName}</span>
        {preview.dateRange && (
          <span className="small text-muted">{preview.dateRange.from} – {preview.dateRange.to}</span>
        )}
        <span className="small text-muted ms-auto">
          {preview.summary.totalSchemes} schemes · <span className="text-success fw-medium">{preview.summary.newTransactions} new</span>
          {preview.summary.updateTransactions > 0 && <> · <span className="text-primary fw-medium">{preview.summary.updateTransactions} updates</span></>}
          {preview.summary.existingTransactions > 0 && <> · {preview.summary.existingTransactions} in DB</>}
        </span>
      </div>

      {/* Select All */}
      <div className="d-flex align-items-center gap-2 mb-2">
        <Form.Check
          type="checkbox"
          checked={allSelected}
          onChange={() => {
            if (allSelected) setSelectedSchemes(new Set());
            else setSelectedSchemes(new Set(allWithChanges));
          }}
          label={<span className="small text-muted">Select all schemes with new or updated transactions</span>}
        />
      </div>

      {/* Scheme List — only schemes with new or updated transactions */}
      {preview.schemes.filter(schemeHasChanges).length === 0 && (
        <div className="text-center text-muted small py-3 border rounded mb-2">
          No new or updated transactions — everything in this statement is already in sync.
        </div>
      )}
      {preview.schemes
        .map((scheme, idx) => ({ scheme, idx }))
        .filter(({ scheme }) => schemeHasChanges(scheme))
        .map(({ scheme, idx }) => {
        const isExpanded = expandedScheme === idx;
        const isSelected = selectedSchemes.has(idx);
        const hasNew = scheme.newTransactionCount > 0;
        const hasUpdates = (scheme.updateTransactionCount || 0) > 0;
        const hasChanges = hasNew || hasUpdates;
        // Only show rows that will actually change the DB (new or update); hide unchanged.
        const visibleTxns = scheme.transactions.filter(t => t.status === 'new' || t.status === 'update');

        return (
          <div key={idx} className="border rounded mb-2 overflow-hidden" style={{ opacity: hasChanges ? 1 : 0.6 }}>
            {/* Scheme Header */}
            <div className="d-flex align-items-center px-3 py-2" style={{ backgroundColor: isSelected ? '#eff6ff' : 'transparent' }}>
              <Form.Check
                type="checkbox"
                checked={isSelected}
                disabled={!hasChanges}
                onChange={() => {
                  const next = new Set(selectedSchemes);
                  if (next.has(idx)) next.delete(idx);
                  else next.add(idx);
                  setSelectedSchemes(next);
                }}
                className="me-2"
              />
              <button
                onClick={() => setExpandedScheme(isExpanded ? null : idx)}
                className="flex-grow-1 bg-transparent border-0 text-start p-0 d-flex align-items-center"
                style={{ cursor: 'pointer' }}
              >
                <div className="flex-grow-1">
                  <div className="small fw-medium">{scheme.schemeName}</div>
                  <div className="d-flex align-items-center gap-2" style={{ fontSize: '0.7rem' }}>
                    <span className="text-muted font-monospace">{scheme.isin}</span>
                    {scheme.folio && <span className="text-muted">Folio: {scheme.folio}</span>}
                    <span className="text-muted">{scheme.amc}</span>
                  </div>
                </div>
                <div className="d-flex align-items-center gap-2 ms-2">
                  {hasNew && (
                    <span className="badge" style={{ fontSize: '0.65rem', backgroundColor: '#dcfce7', color: '#15803d' }}>
                      {scheme.newTransactionCount} new
                    </span>
                  )}
                  {hasUpdates && (
                    <span className="badge" style={{ fontSize: '0.65rem', backgroundColor: '#dbeafe', color: '#1d4ed8' }}>
                      {scheme.updateTransactionCount} update{scheme.updateTransactionCount !== 1 ? 's' : ''}
                    </span>
                  )}
                  {!hasChanges && (
                    <span className="badge bg-light text-muted" style={{ fontSize: '0.65rem' }}>
                      all in DB
                    </span>
                  )}
                  {scheme.closingBalance > 0 && (
                    <span className="small text-muted">{scheme.closingBalance.toLocaleString('en-IN', { maximumFractionDigits: 4 })} units</span>
                  )}
                  <ChevronDown size={14} className="text-muted" style={{ transition: 'transform 0.2s', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }} />
                </div>
              </button>
            </div>

            {/* Expanded Transaction List */}
            {isExpanded && (
              <div className="border-top">
                {scheme.exitLoad && (
                  <div className="px-3 py-1" style={{ fontSize: '0.7rem', backgroundColor: '#fefce8', color: '#854d0e' }}>
                    Exit Load: {scheme.exitLoad}
                  </div>
                )}
                <div className="table-responsive" style={{ maxHeight: 300, overflowY: 'auto' }}>
                  <Table size="sm" className="mb-0" style={{ fontSize: '0.75rem' }}>
                    <thead className="table-light">
                      <tr>
                        <th className="px-2 py-1">Date</th>
                        <th className="px-2 py-1">Type</th>
                        <th className="px-2 py-1 text-end">Amount</th>
                        <th className="px-2 py-1 text-end">Units</th>
                        <th className="px-2 py-1 text-end">Price</th>
                        <th className="px-2 py-1 text-end">STT</th>
                        <th className="px-2 py-1">Description</th>
                        <th className="px-2 py-1">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleTxns.length === 0 ? (
                        <tr><td colSpan={8} className="px-2 py-2 text-center text-muted">Nothing to import — all transactions already in DB.</td></tr>
                      ) : visibleTxns.map((t, ti) => (
                        <tr key={ti}>
                          <td className="px-2 py-1 text-nowrap">{t.date}</td>
                          <td className="px-2 py-1">
                            <span className={`badge ${t.type === 'BUY' ? 'bg-success' : t.type === 'SELL' ? 'bg-danger' : 'bg-secondary'}`}
                              style={{ fontSize: '0.65rem' }}>
                              {t.type}
                            </span>
                          </td>
                          <td className="px-2 py-1 text-end">{formatCurrency(t.amount)}</td>
                          <td className="px-2 py-1 text-end">{Math.abs(t.units || 0).toLocaleString('en-IN', { maximumFractionDigits: 4 })}</td>
                          <td className="px-2 py-1 text-end">{formatCurrency(t.price)}</td>
                          <td className="px-2 py-1 text-end">
                            {t.status === 'update'
                              ? <span className="text-primary">{formatCurrency(t.existing_stt || 0)} → {formatCurrency(t.new_stt || 0)}</span>
                              : formatCurrency(t.new_stt || 0)}
                          </td>
                          <td className="px-2 py-1 text-muted text-truncate" style={{ maxWidth: 180 }}>{t.description}</td>
                          <td className="px-2 py-1">
                            {t.status === 'new' ? (
                              <span className="badge" style={{ fontSize: '0.6rem', backgroundColor: '#dcfce7', color: '#15803d' }}>New</span>
                            ) : (
                              <span className="badge" style={{ fontSize: '0.6rem', backgroundColor: '#dbeafe', color: '#1d4ed8' }}>Update</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
                {scheme.latestNav && (
                  <div className="px-3 py-1 text-muted" style={{ fontSize: '0.7rem' }}>
                    NAV: {formatCurrency(scheme.latestNav)} | Market Value: {formatCurrency(scheme.marketValue)}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Import Bar */}
      <div className="bg-light border rounded p-2 mt-3 d-flex align-items-center justify-content-between">
        <div className="small text-muted">
          <strong>{selectedNewTxns}</strong> new · <strong>{selectedUpdateTxns}</strong> update{selectedUpdateTxns !== 1 ? 's' : ''} in <strong>{selectedSchemes.size}</strong> scheme{selectedSchemes.size !== 1 ? 's' : ''} selected
        </div>
        <div className="d-flex gap-2">
          <Button size="sm" variant="outline-secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm" variant="success"
            onClick={onImport}
            disabled={importing || (selectedNewTxns === 0 && selectedUpdateTxns === 0)}
          >
            {importing ? (
              <><Spinner size="sm" className="me-1" /> Importing...</>
            ) : (
              <><CheckCircle size={14} className="me-1" /> Import {selectedNewTxns + selectedUpdateTxns} Transactions</>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
