// 2500 -> "Rs. 2,500"    1499.5 -> "Rs. 1,499.5"
const formatPrice = (price) => {
  const amount = Number(price) || 0;
  return `Rs. ${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
};

export default formatPrice;
