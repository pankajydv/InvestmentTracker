const express = require('express');
const router = express.Router();

module.exports = function (db) {

  // ─── Portfolio Summary (Dashboard) ────────────────────────────────────
  router.get('/summary', (req, res) => {
    const { portfolio_id, hide_sold } = req.query;

    // Get latest portfolio snapshot
    let latest;
    if (portfolio_id) {
      latest = db.prepare(
        'SELECT * FROM portfolio_daily WHERE portfolio_id = ? ORDER BY date DESC LIMIT 1'
      ).get(portfolio_id);
    } else {
      latest = db.prepare(
        'SELECT * FROM portfolio_daily WHERE portfolio_id IS NULL ORDER BY date DESC LIMIT 1'
      ).get();
    }

    // Build WHERE clause for portfolio filter
    const portfolioFilter = portfolio_id ? ' AND i.portfolio_id = ?' : '';
    const portfolioParams = portfolio_id ? [portfolio_id] : [];

    // Build hide-sold filter
    const soldFilter = hide_sold === 'true'
      ? ` AND (i.asset_type IN ('PPF','PF') OR COALESCE((SELECT SUM(CASE WHEN transaction_type IN ('BUY','DEPOSIT','BONUS','RIGHTS','IPO','TRANSFER_IN','SPLIT') THEN COALESCE(units,0) WHEN transaction_type IN ('SELL','REDEMPTION','WITHDRAWAL','TRANSFER_OUT','CONSOLIDATION') THEN -COALESCE(units,0) ELSE 0 END) FROM transactions WHERE investment_id = i.id),0) > 0)`
      : '';

    // Get individual investment summaries
    const investments = db.prepare(`
      SELECT
        i.id, i.name, i.asset_type, i.ticker_symbol, i.amfi_code, i.currency, i.portfolio_id,
        dv.date, dv.price_per_unit, dv.total_units, dv.current_value,
        dv.invested_amount, dv.profit_loss, dv.profit_loss_pct,
        dv.day_change, dv.day_change_pct,
        p.name as portfolio_name, p.color as portfolio_color
      FROM investments i
      LEFT JOIN daily_values dv ON i.id = dv.investment_id
        AND dv.date = (SELECT MAX(date) FROM daily_values WHERE investment_id = i.id)
      LEFT JOIN portfolios p ON i.portfolio_id = p.id
      WHERE i.is_active = 1${portfolioFilter}${soldFilter}
      ORDER BY i.asset_type, i.name
    `).all(...portfolioParams);

    // Group by asset type
    const byType = {};
    for (const inv of investments) {
      if (!byType[inv.asset_type]) {
        byType[inv.asset_type] = { 
          investments: [], 
          totalValue: 0, 
          totalInvested: 0, 
          totalProfitLoss: 0,
          dayChange: 0 
        };
      }
      byType[inv.asset_type].investments.push(inv);
      byType[inv.asset_type].totalValue += inv.current_value || 0;
      byType[inv.asset_type].totalInvested += inv.invested_amount || 0;
      byType[inv.asset_type].totalProfitLoss += inv.profit_loss || 0;
      byType[inv.asset_type].dayChange += inv.day_change || 0;
    }

    // Calculate percentages of portfolio
    const totalValue = latest?.total_value || investments.reduce((s, i) => s + (i.current_value || 0), 0);
    for (const inv of investments) {
      inv.portfolio_pct = totalValue > 0 ? ((inv.current_value || 0) / totalValue) * 100 : 0;
    }

    // Get portfolio count info
    const portfolioCount = db.prepare('SELECT COUNT(*) as count FROM portfolios').get().count;

    res.json({
      portfolio: latest || {
        total_value: 0,
        total_invested: 0,
        total_profit_loss: 0,
        total_profit_loss_pct: 0,
        day_change: 0,
        day_change_pct: 0,
      },
      investments,
      byType,
      portfolioCount,
      lastUpdate: db.prepare("SELECT value FROM config WHERE key = 'last_price_update'").get()?.value,
    });
  });

  // ─── Performance over time periods ─────────────────────────────────────
  router.get('/performance', (req, res) => {
    const { period, from, to, portfolio_id } = req.query;

    let startDate, endDate;
    const now = new Date();
    endDate = now.toISOString().split('T')[0];

    if (from && to) {
      startDate = from;
      endDate = to;
    } else {
      switch (period) {
        case '1D': startDate = new Date(now - 1 * 86400000).toISOString().split('T')[0]; break;
        case '7D': startDate = new Date(now - 7 * 86400000).toISOString().split('T')[0]; break;
        case '1M': { const d = new Date(now); d.setMonth(d.getMonth() - 1); startDate = d.toISOString().split('T')[0]; break; }
        case '3M': { const d = new Date(now); d.setMonth(d.getMonth() - 3); startDate = d.toISOString().split('T')[0]; break; }
        case '6M': { const d = new Date(now); d.setMonth(d.getMonth() - 6); startDate = d.toISOString().split('T')[0]; break; }
        case '1Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 1); startDate = d.toISOString().split('T')[0]; break; }
        case '2Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 2); startDate = d.toISOString().split('T')[0]; break; }
        case '3Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 3); startDate = d.toISOString().split('T')[0]; break; }
        case '5Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 5); startDate = d.toISOString().split('T')[0]; break; }
        default: { const d = new Date(now); d.setMonth(d.getMonth() - 1); startDate = d.toISOString().split('T')[0]; }
      }
    }

    // Portfolio level performance — filtered by portfolio_id
    let portfolioData;
    if (portfolio_id) {
      portfolioData = db.prepare(`
        SELECT * FROM portfolio_daily
        WHERE portfolio_id = ? AND date BETWEEN ? AND ?
        ORDER BY date ASC
      `).all(portfolio_id, startDate, endDate);
    } else {
      portfolioData = db.prepare(`
        SELECT * FROM portfolio_daily
        WHERE portfolio_id IS NULL AND date BETWEEN ? AND ?
        ORDER BY date ASC
      `).all(startDate, endDate);
    }

    // Per-investment performance
    const investmentFilter = portfolio_id ? ' AND i.portfolio_id = ?' : '';
    const investmentParams = portfolio_id
      ? [startDate, endDate, portfolio_id]
      : [startDate, endDate];

    const investmentData = db.prepare(`
      SELECT dv.*, i.name, i.asset_type
      FROM daily_values dv
      JOIN investments i ON dv.investment_id = i.id
      WHERE dv.date BETWEEN ? AND ? AND i.is_active = 1${investmentFilter}
      ORDER BY dv.date ASC, i.name ASC
    `).all(...investmentParams);

    // Calculate period returns
    const startSnapshot = portfolioData[0];
    const endSnapshot = portfolioData[portfolioData.length - 1];
    let periodReturn = 0;
    let periodReturnPct = 0;

    if (startSnapshot && endSnapshot) {
      periodReturn = endSnapshot.total_value - startSnapshot.total_value;
      periodReturnPct = startSnapshot.total_value > 0
        ? (periodReturn / startSnapshot.total_value) * 100 : 0;
    }

    res.json({
      period: period || 'custom',
      startDate,
      endDate,
      portfolioData,
      investmentData,
      periodReturn: Math.round(periodReturn * 100) / 100,
      periodReturnPct: Math.round(periodReturnPct * 100) / 100,
    });
  });

  // ─── Individual investment performance ────────────────────────────────
  router.get('/performance/:investmentId', (req, res) => {
    const { period } = req.query;
    const now = new Date();
    let startDate;

    switch (period) {
      case '1D': startDate = new Date(now - 2 * 86400000).toISOString().split('T')[0]; break;
      case '7D': startDate = new Date(now - 7 * 86400000).toISOString().split('T')[0]; break;
      case '1M': { const d = new Date(now); d.setMonth(d.getMonth() - 1); startDate = d.toISOString().split('T')[0]; break; }
      case '3M': { const d = new Date(now); d.setMonth(d.getMonth() - 3); startDate = d.toISOString().split('T')[0]; break; }
      case '6M': { const d = new Date(now); d.setMonth(d.getMonth() - 6); startDate = d.toISOString().split('T')[0]; break; }
      case '1Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 1); startDate = d.toISOString().split('T')[0]; break; }
      case '3Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 3); startDate = d.toISOString().split('T')[0]; break; }
      case '5Y': { const d = new Date(now); d.setFullYear(d.getFullYear() - 5); startDate = d.toISOString().split('T')[0]; break; }
      default: { const d = new Date(now); d.setFullYear(d.getFullYear() - 1); startDate = d.toISOString().split('T')[0]; }
    }

    const data = db.prepare(`
      SELECT * FROM daily_values
      WHERE investment_id = ? AND date >= ?
      ORDER BY date ASC
    `).all(req.params.investmentId, startDate);

    res.json(data);
  });

  // ─── Asset allocation breakdown ───────────────────────────────────────
  router.get('/allocation', (req, res) => {
    const { portfolio_id } = req.query;
    const portfolioFilter = portfolio_id ? ' AND i.portfolio_id = ?' : '';
    const params = portfolio_id ? [portfolio_id] : [];

    const allocation = db.prepare(`
      SELECT
        i.asset_type,
        COUNT(*) as count,
        COALESCE(SUM(dv.current_value), 0) as total_value,
        COALESCE(SUM(dv.invested_amount), 0) as total_invested,
        COALESCE(SUM(dv.profit_loss), 0) as total_profit_loss
      FROM investments i
      LEFT JOIN daily_values dv ON i.id = dv.investment_id
        AND dv.date = (SELECT MAX(date) FROM daily_values WHERE investment_id = i.id)
      WHERE i.is_active = 1${portfolioFilter}
      GROUP BY i.asset_type
    `).all(...params);

    res.json(allocation);
  });

  return router;
};
