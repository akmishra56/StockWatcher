/**
 * Standard risk/educational-use disclaimer. Shown as a blocking popup on
 * every app load (not just once-ever -- per the user's explicit instruction,
 * "every time user opens the app URL"), and reachable afterward via the
 * always-visible "Disclaimer" link in the top bar (see App.tsx).
 */
export function DisclaimerModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="disclaimer-overlay" role="dialog" aria-modal="true" aria-labelledby="disclaimer-title">
      <div className="disclaimer-modal">
        <h2 id="disclaimer-title" className="disclaimer-title">Disclaimer</h2>
        <div className="disclaimer-body">
          <p>
            StockWatcher is provided for <strong>educational and informational purposes only</strong>.
            Nothing shown in this application -- prices, indicators, filters, alerts, or any other
            output -- constitutes financial, investment, or trading advice, or a recommendation to
            buy, sell, or hold any security or financial instrument.
          </p>
          <p>
            Trading and investing in equities, derivatives, and other financial instruments carries
            substantial risk, including the potential loss of your entire capital. Past performance
            and technical indicators are not reliable indicators of future results.
          </p>
          <p>
            You should independently evaluate your own financial situation and consult a qualified,
            SEBI-registered financial advisor before making any investment or trading decision. The
            creators and operators of this application accept no liability for any loss or damage
            arising from reliance on the data or tools provided here.
          </p>
        </div>
        <button className="chip-toggle chip-toggle-active disclaimer-ack" onClick={onClose}>
          I Understand
        </button>
      </div>
    </div>
  );
}
