import { useState } from "react";

// Shows the product image, or a simple placeholder when there is no image
// (or when the image address is broken).
function ProductImage({ imageUrl, name, className = "" }) {
  const [failed, setFailed] = useState(false);

  if (!imageUrl || failed) {
    return (
      <div className={`product-image product-image-placeholder ${className}`}>
        <span>No image</span>
      </div>
    );
  }

  return (
    <img
      className={`product-image ${className}`}
      src={imageUrl}
      alt={name}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

export default ProductImage;
