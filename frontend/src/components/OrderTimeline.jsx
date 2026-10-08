import { buildTimeline, capitalize, formatOrderDate } from "../utils/orderDisplay.js";

// What each step means for a screen reader (the colours alone say nothing to them)
const STATE_TEXT = {
  done: "completed",
  current: "current step",
  upcoming: "not reached yet",
  cancelled: "order cancelled",
};

// The progress of an order: Pending, Confirmed, Processing, Shipped, Delivered.
// The steps come from buildTimeline, which only uses the status and history the server sent.
// A cancelled order shows the steps it reached and then "Cancelled". Notes are never shown.
function OrderTimeline({ order }) {
  const steps = buildTimeline(order);

  return (
    <section className="checkout-section" aria-labelledby="progress-heading">
      <h2 id="progress-heading">Order progress</h2>
      <ol className="order-timeline">
        {steps.map((step) => (
          <li key={step.status} className={`timeline-step timeline-step-${step.state}`}>
            <span className="timeline-marker" aria-hidden="true"></span>
            <span className="timeline-label">{capitalize(step.status)}</span>
            <span className="visually-hidden"> ({STATE_TEXT[step.state]})</span>
            {step.changedAt && <span className="timeline-date">{formatOrderDate(step.changedAt)}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

export default OrderTimeline;
