const LOW_STOCK_LIMIT = 5;

// Returns the text to show and a CSS class for the colour of the badge
const getStockStatus = (stock) => {
  if (stock <= 0) {
    return { label: "Out of stock", className: "badge-out" };
  }
  if (stock <= LOW_STOCK_LIMIT) {
    return { label: `Only ${stock} left`, className: "badge-low" };
  }
  return { label: "In stock", className: "badge-in" };
};

export default getStockStatus;
