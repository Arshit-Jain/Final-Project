import { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

// Get API URL from environment variable (for production)
const API_BASE_URL = import.meta.env.VITE_API_URL || '';

function App() {
  const [stats, setStats] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [selectedSession, setSelectedSession] = useState(null);
  const [sessionDetails, setSessionDetails] = useState(null);
  const [loading, setLoading] = useState(true);
  
  // Chart state
  const [chartView, setChartView] = useState('day');
  const [chartDate, setChartDate] = useState(new Date().toISOString().split('T')[0]);
  const [chartData, setChartData] = useState([]);
  const [chartLoading, setChartLoading] = useState(true);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    fetchChartData();
  }, [chartView, chartDate]);

  const fetchData = async () => {
    try {
      const [statsRes, sessionsRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/stats`),
        fetch(`${API_BASE_URL}/api/sessions`)
      ]);
      
      const statsData = await statsRes.json();
      const sessionsData = await sessionsRes.json();
      
      setStats(statsData);
      setSessions(sessionsData.sessions || []);
    } catch (err) {
      console.error('Error fetching data:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchChartData = async () => {
    setChartLoading(true);
    try {
      const params = new URLSearchParams({ view: chartView });
      if (chartView === 'day') {
        params.append('date', chartDate);
      }
      
      const res = await fetch(`${API_BASE_URL}/api/analytics/hourly-clicks?${params}`);
      const data = await res.json();
      
      // Validate response
      if (!data || !data.data || !Array.isArray(data.data)) {
        console.error('Invalid chart data response:', data);
        setChartData([]);
        return;
      }
      
      if (chartView === 'day') {
        // Convert GMT hours to MDT (UTC-6)
        const processedData = data.data.map(row => {
          const gmtHour = parseInt(row.hour, 10);
          if (isNaN(gmtHour)) {
            console.error('Invalid hour value:', row.hour);
            return null;
          }
          
          const mdtHour = gmtHour - 6;
          
          // Handle hour display (convert to 12-hour format with AM/PM)
          let displayHour = mdtHour;
          if (displayHour < 0) displayHour += 24;
          if (displayHour >= 24) displayHour -= 24;
          
          const period = displayHour >= 12 ? 'PM' : 'AM';
          const hour12 = displayHour === 0 ? 12 : displayHour > 12 ? displayHour - 12 : displayHour;
          
          return {
            time: `${hour12}${period}`,
            clicks: parseInt(row.clicks, 10) || 0,
            sortOrder: displayHour
          };
        }).filter(Boolean);
        
        setChartData(processedData.sort((a, b) => a.sortOrder - b.sortOrder));
      } else {
        // Format data for week view
        const dayMap = {};
        data.data.forEach(row => {
          if (!row.date) return;
          
          if (!dayMap[row.date]) {
            dayMap[row.date] = { date: row.date, clicks: 0 };
          }
          dayMap[row.date].clicks += parseInt(row.clicks, 10) || 0;
        });
        setChartData(Object.values(dayMap));
      }
    } catch (err) {
      console.error('Error fetching chart data:', err);
      setChartData([]);
    } finally {
      setChartLoading(false);
    }
  };

  const fetchSessionDetails = async (sessionId) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/sessions/${sessionId}`);
      const data = await res.json();
      setSessionDetails(data);
      setSelectedSession(sessionId);
    } catch (err) {
      console.error('Error fetching session details:', err);
    }
  };

  const formatDuration = (seconds) => {
    if (!seconds || seconds < 0) return '0s';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  };

  const formatTimestamp = (timestamp) => {
    return new Date(timestamp).toLocaleString();
  };

  const handleDateChange = (days) => {
    const newDate = new Date(chartDate);
    newDate.setDate(newDate.getDate() + days);
    setChartDate(newDate.toISOString().split('T')[0]);
  };

  if (loading) return <div className="loading">Loading analytics...</div>;

  // Calculate active sessions
  const activeSessions = sessions.filter(s => {
    if (!s || !s.start_time) return false;
    const lastActivity = new Date(s.end_time || s.start_time);
    return Date.now() - lastActivity.getTime() < 300000;
  }).length;

  return (
    <div className="dashboard">
      <header>
        <h1>📊 Pixel Analytics Dashboard</h1>
        <p>Real-time tracking and session analysis</p>
      </header>

      {/* Summary Cards */}
      <div className="grid">
        <div className="card">
          <h3>Total Sessions</h3>
          <div className="value">{stats?.total_sessions || 0}</div>
        </div>
        <div className="card">
          <h3>Total Events</h3>
          <div className="value">{stats?.total_events || 0}</div>
        </div>
        <div className="card">
          <h3>Avg Duration</h3>
          <div className="value">{formatDuration(stats?.avg_session_duration || 0)}</div>
        </div>
        <div className="card">
          <h3>Active Now</h3>
          <div className="value">{activeSessions}</div>
        </div>
      </div>

      {/* Hourly Click Analytics Chart */}
      <div className="section chart-section">
        <div className="chart-header">
          <h2>📈 Click Analytics</h2>
          <div className="chart-controls">
            <div className="view-toggle">
              <button 
                className={chartView === 'day' ? 'active' : ''}
                onClick={() => setChartView('day')}
              >
                Daily
              </button>
              <button 
                className={chartView === 'week' ? 'active' : ''}
                onClick={() => setChartView('week')}
              >
                Weekly
              </button>
            </div>
            
            {chartView === 'day' && (
              <div className="date-controls">
                <button onClick={() => handleDateChange(-1)}>←</button>
                <input 
                  type="date" 
                  value={chartDate}
                  onChange={(e) => setChartDate(e.target.value)}
                  max={new Date().toISOString().split('T')[0]}
                />
                <button 
                  onClick={() => handleDateChange(1)}
                  disabled={chartDate >= new Date().toISOString().split('T')[0]}
                >
                  →
                </button>
              </div>
            )}
          </div>
        </div>

        {chartLoading ? (
          <div className="chart-loading">Loading chart data...</div>
        ) : chartData.length === 0 ? (
          <div className="no-data">No click data available for this period</div>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis 
                dataKey={chartView === 'day' ? 'time' : 'date'}
                stroke="#64748b"
                style={{ fontSize: '12px' }}
              />
              <YAxis 
                stroke="#64748b"
                style={{ fontSize: '12px' }}
                allowDecimals={false}
              />
              <Tooltip 
                contentStyle={{
                  backgroundColor: '#fff',
                  border: '1px solid #e2e8f0',
                  borderRadius: '8px',
                  padding: '8px 12px'
                }}
              />
              <Legend />
              <Line 
                type="monotone" 
                dataKey="clicks" 
                stroke="#3b82f6" 
                strokeWidth={2}
                dot={{ fill: '#3b82f6', r: 4 }}
                activeDot={{ r: 6 }}
                name="Clicks"
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Sessions List */}
      <div className="section">
        <h2>Recent Sessions</h2>
        {sessions.length === 0 ? (
          <p className="no-data">No sessions yet. Start tracking to see data!</p>
        ) : (
          <div className="sessions-list">
            {sessions.map((session) => (
              <div 
                key={session.session_id} 
                className={`session-card ${selectedSession === session.session_id ? 'active' : ''}`}
                onClick={() => fetchSessionDetails(session.session_id)}
              >
                <div className="session-header">
                  <span className="session-id" title={session.session_id}>
                    🔗 {session.session_id.substring(0, 16)}...
                  </span>
                  <span className="session-time">{formatTimestamp(session.start_time)}</span>
                </div>
                <div className="session-stats">
                  <span>📄 {session.page_views} pages</span>
                  <span>⏱️ {formatDuration(session.duration)}</span>
                  <span>👆 {session.total_clicks || 0} clicks</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Session Details */}
      {sessionDetails && (
        <div className="section session-details">
          <div className="detail-header">
            <h2>Session Details</h2>
            <button onClick={() => setSelectedSession(null)} className="close-btn">✕</button>
          </div>

          <div className="info-grid">
            <div className="info-item">
              <label>Session ID</label>
              <span>{String(sessionDetails.session_id || 'N/A')}</span>
            </div>
            <div className="info-item">
              <label>Start Time</label>
              <span>{sessionDetails.start_time ? formatTimestamp(sessionDetails.start_time) : 'N/A'}</span>
            </div>
            <div className="info-item">
              <label>Duration</label>
              <span>{formatDuration(sessionDetails.duration)}</span>
            </div>
            <div className="info-item">
              <label>Total Events</label>
              <span>{sessionDetails.events?.length || 0}</span>
            </div>
          </div>

          {/* Pages Visited */}
          <div className="detail-section">
            <h3>📄 Pages Visited</h3>
            {sessionDetails.pages?.length > 0 ? (
              <div className="pages-list">
                {sessionDetails.pages.map((page, idx) => (
                  <div key={idx} className="page-item">
                    <div className="page-url">{page.url}</div>
                    <div className="page-meta">
                      <span>⏱️ {formatDuration(page.time_on_page || 0)}</span>
                      <span>👀 {page.view_count || 0} view{(page.view_count || 0) > 1 ? 's' : ''}</span>
                      <span className="timestamp">{page.first_visit ? formatTimestamp(page.first_visit) : 'N/A'}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="no-data">No pages visited</p>
            )}
          </div>

          {/* Click Events */}
          <div className="detail-section">
            <h3>👆 Click Events</h3>
            {sessionDetails.clicks?.length > 0 ? (
              <div className="clicks-list">
                {sessionDetails.clicks.map((click, idx) => (
                  <div key={idx} className="click-item">
                    <div className="click-header">
                      <span className="click-target">Click Event</span>
                      <span className="click-time">{click.timestamp ? formatTimestamp(click.timestamp) : 'N/A'}</span>
                    </div>
                    {click.url && (
                      <div className="click-text">URL: {click.url}</div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="no-data">No clicks recorded</p>
            )}
          </div>

          {/* All Events Timeline */}
          <div className="detail-section">
            <h3>📋 Full Event Timeline</h3>
            {sessionDetails.events?.length > 0 ? (
              <div className="timeline">
                {sessionDetails.events.map((event, idx) => (
                  <div key={idx} className="timeline-item">
                    <div className="timeline-marker">
                      {event.event_type === 'pageview' ? '📄' : 
                       event.event_type === 'click' ? '👆' : '📍'}
                    </div>
                    <div className="timeline-content">
                      <div className="timeline-header">
                        <span className="event-type">{event.event_type || 'unknown'}</span>
                        <span className="event-time">{event.timestamp ? formatTimestamp(event.timestamp) : 'N/A'}</span>
                      </div>
                      <div className="event-url">{event.url || 'N/A'}</div>
                      {event.metadata && Object.keys(event.metadata).length > 0 && (
                        <div className="event-metadata">
                          {JSON.stringify(event.metadata, null, 2)}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="no-data">No events recorded</p>
            )}
          </div>
        </div>
      )}

      <style>{`
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
          background: #f8fafc;
          color: #1e293b;
        }

        .dashboard {
          max-width: 1400px;
          margin: 0 auto;
          padding: 20px;
        }

        header {
          margin-bottom: 30px;
          text-align: center;
        }

        h1 {
          font-size: 2rem;
          margin-bottom: 8px;
          color: #0f172a;
        }

        h2 {
          font-size: 1.5rem;
          margin-bottom: 16px;
          color: #334155;
        }

        h3 {
          font-size: 1.125rem;
          margin-bottom: 12px;
          color: #475569;
        }

        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
          gap: 16px;
          margin-bottom: 32px;
        }

        .card {
          background: white;
          padding: 24px;
          border-radius: 12px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.1);
          border: 1px solid #e2e8f0;
        }

        .card h3 {
          font-size: 0.875rem;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: #64748b;
          margin-bottom: 8px;
        }

        .value {
          font-size: 2.5rem;
          font-weight: 700;
          color: #3b82f6;
        }

        .section {
          background: white;
          padding: 24px;
          border-radius: 12px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.1);
          border: 1px solid #e2e8f0;
          margin-bottom: 24px;
        }

        .chart-section {
          padding-bottom: 32px;
        }

        .chart-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 24px;
          flex-wrap: wrap;
          gap: 16px;
        }

        .chart-controls {
          display: flex;
          gap: 16px;
          align-items: center;
          flex-wrap: wrap;
        }

        .view-toggle {
          display: flex;
          gap: 0;
          border: 2px solid #e2e8f0;
          border-radius: 8px;
          overflow: hidden;
        }

        .view-toggle button {
          padding: 8px 20px;
          background: white;
          border: none;
          cursor: pointer;
          font-size: 0.875rem;
          font-weight: 500;
          color: #64748b;
          transition: all 0.2s;
        }

        .view-toggle button:not(:last-child) {
          border-right: 2px solid #e2e8f0;
        }

        .view-toggle button.active {
          background: #3b82f6;
          color: white;
        }

        .view-toggle button:hover:not(.active) {
          background: #f8fafc;
        }

        .date-controls {
          display: flex;
          gap: 8px;
          align-items: center;
        }

        .date-controls button {
          padding: 8px 16px;
          background: white;
          border: 2px solid #e2e8f0;
          border-radius: 6px;
          cursor: pointer;
          font-size: 1rem;
          font-weight: 600;
          color: #64748b;
          transition: all 0.2s;
        }

        .date-controls button:hover:not(:disabled) {
          border-color: #3b82f6;
          color: #3b82f6;
        }

        .date-controls button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .date-controls input[type="date"] {
          padding: 8px 12px;
          border: 2px solid #e2e8f0;
          border-radius: 6px;
          font-size: 0.875rem;
          color: #0f172a;
          background: white;
        }

        .date-controls input[type="date"]:focus {
          outline: none;
          border-color: #3b82f6;
        }

        .chart-loading {
          text-align: center;
          padding: 80px 20px;
          color: #64748b;
          font-style: italic;
        }

        .sessions-list {
          display: grid;
          gap: 12px;
        }

        .session-card {
          padding: 16px;
          border: 2px solid #e2e8f0;
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.2s;
        }

        .session-card:hover {
          border-color: #3b82f6;
          background: #f8fafc;
        }

        .session-card.active {
          border-color: #3b82f6;
          background: #eff6ff;
        }

        .session-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }

        .session-id {
          font-weight: 600;
          color: #0f172a;
          font-family: 'Monaco', monospace;
          font-size: 0.875rem;
        }

        .session-time {
          font-size: 0.875rem;
          color: #64748b;
        }

        .session-stats {
          display: flex;
          gap: 16px;
          font-size: 0.875rem;
          color: #475569;
        }

        .session-details {
          border: 2px solid #3b82f6;
        }

        .detail-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 24px;
        }

        .close-btn {
          background: #ef4444;
          color: white;
          border: none;
          width: 32px;
          height: 32px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 1.25rem;
        }

        .close-btn:hover {
          background: #dc2626;
        }

        .info-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 16px;
          margin-bottom: 32px;
          padding: 16px;
          background: #f8fafc;
          border-radius: 8px;
        }

        .info-item {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .info-item label {
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: #64748b;
          font-weight: 600;
        }

        .info-item span {
          font-size: 0.875rem;
          color: #0f172a;
          font-family: 'Monaco', monospace;
        }

        .detail-section {
          margin-top: 32px;
          padding-top: 24px;
          border-top: 1px solid #e2e8f0;
        }

        .pages-list, .clicks-list {
          display: grid;
          gap: 12px;
        }

        .page-item, .click-item {
          padding: 12px;
          background: #f8fafc;
          border-radius: 6px;
          border-left: 4px solid #3b82f6;
        }

        .page-url {
          font-size: 0.875rem;
          color: #0f172a;
          margin-bottom: 6px;
          word-break: break-all;
        }

        .page-meta {
          display: flex;
          gap: 16px;
          font-size: 0.75rem;
          color: #64748b;
        }

        .click-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 6px;
        }

        .click-target {
          font-weight: 600;
          color: #0f172a;
          background: #e0e7ff;
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 0.75rem;
        }

        .click-time {
          font-size: 0.75rem;
          color: #64748b;
        }

        .click-text {
          font-size: 0.875rem;
          color: #475569;
          margin-top: 6px;
          font-style: italic;
        }

        .timeline {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .timeline-item {
          display: flex;
          gap: 16px;
        }

        .timeline-marker {
          flex-shrink: 0;
          width: 40px;
          height: 40px;
          background: #eff6ff;
          border: 2px solid #3b82f6;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 1.25rem;
        }

        .timeline-content {
          flex: 1;
          padding: 12px;
          background: #f8fafc;
          border-radius: 8px;
        }

        .timeline-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }

        .event-type {
          font-weight: 600;
          color: #0f172a;
          text-transform: uppercase;
          font-size: 0.75rem;
          background: #dbeafe;
          padding: 2px 8px;
          border-radius: 4px;
        }

        .event-time {
          font-size: 0.75rem;
          color: #64748b;
        }

        .event-url {
          font-size: 0.875rem;
          color: #475569;
          word-break: break-all;
          margin-bottom: 6px;
        }

        .event-metadata {
          font-size: 0.75rem;
          font-family: 'Monaco', monospace;
          background: #f1f5f9;
          padding: 8px;
          border-radius: 4px;
          color: #334155;
          white-space: pre-wrap;
        }

        .no-data {
          text-align: center;
          color: #94a3b8;
          padding: 32px;
          font-style: italic;
        }

        .loading {
          display: flex;
          justify-content: center;
          align-items: center;
          height: 100vh;
          font-size: 1.25rem;
          color: #64748b;
        }

        .timestamp {
          color: #94a3b8 !important;
          font-size: 0.7rem !important;
        }
      `}</style>
    </div>
  );
}

export default App;