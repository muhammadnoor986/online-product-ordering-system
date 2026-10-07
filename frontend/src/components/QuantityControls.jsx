// "−  3  +" buttons. It only reports the wish (onChange); the server decides.
// The buttons are switched off at the limits, so quantity can never go below `min`
// or above `max`.
function QuantityControls({ productName, quantity, min = 1, max, disabled = false, onChange }) {
  const canDecrease = !disabled && quantity > min;
  const canIncrease = !disabled && quantity < max;

  return (
    <div className="quantity-controls" role="group" aria-label={`Quantity of ${productName}`}>
      <button
        type="button"
        className="quantity-button"
        onClick={() => onChange(quantity - 1)}
        disabled={!canDecrease}
        aria-label={`Decrease quantity of ${productName}`}
      >
        &minus;
      </button>
      <span className="quantity-value" aria-live="polite">
        {quantity}
      </span>
      <button
        type="button"
        className="quantity-button"
        onClick={() => onChange(quantity + 1)}
        disabled={!canIncrease}
        aria-label={`Increase quantity of ${productName}`}
      >
        +
      </button>
    </div>
  );
}

export default QuantityControls;
