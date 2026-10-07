const Product = require("../models/Product");
const Category = require("../models/Category");
const AppError = require("../utils/AppError");
const isValidObjectId = require("../utils/isValidObjectId");

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;

const checkId = (id) => {
  if (!isValidObjectId(id)) {
    throw new AppError("Invalid product id", 400);
  }
};

const isNonEmptyText = (value) => typeof value === "string" && value.trim() !== "";
const isValidPrice = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isValidStock = (value) => Number.isInteger(value) && value >= 0;
// imageUrl is optional, but if given it must be a normal web address
const isValidImageUrl = (value) =>
  typeof value === "string" && (value.trim() === "" || /^https?:\/\/\S+$/i.test(value.trim()));

// Checks each field that is present. When `requireAll` is true (creating a product),
// the required fields must be present too. Returns an array of problems.
const validateProductFields = (body = {}, requireAll) => {
  const errors = [];
  const has = (field) => body[field] !== undefined;

  if (requireAll || has("name")) {
    if (!isNonEmptyText(body.name)) errors.push("Product name is required");
  }
  if (requireAll || has("description")) {
    if (!isNonEmptyText(body.description)) errors.push("Product description is required");
  }
  if (requireAll || has("price")) {
    if (!isValidPrice(body.price)) errors.push("Price must be a number of 0 or more");
  }
  if (requireAll || has("stock")) {
    if (!isValidStock(body.stock)) errors.push("Stock must be a whole number of 0 or more");
  }
  if (has("imageUrl") && !isValidImageUrl(body.imageUrl)) {
    errors.push("Image URL must start with http:// or https://");
  }
  if (has("isActive") && typeof body.isActive !== "boolean") {
    errors.push("isActive must be true or false");
  }
  if (requireAll || has("category")) {
    if (!isValidObjectId(body.category)) errors.push("A valid category id is required");
  }

  return errors;
};

// Throws a 400 if the category id does not match an existing category
const ensureCategoryExists = async (categoryId) => {
  const category = await Category.exists({ _id: categoryId });
  if (!category) {
    throw new AppError("Category does not exist", 400);
  }
};

// Turns "12" into 12. Returns null when the value is not a whole number >= min.
const parseWholeNumber = (value, min) => {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return number >= min ? number : null;
};

const parsePrice = (value) => {
  if (typeof value !== "string" || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

// Escapes characters like ( or * so the search text is treated as plain text
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// GET /api/products (public; ?includeInactive=true is admin only, checked in productRoutes.js)
const getProducts = async (req, res, next) => {
  try {
    const { search, category, minPrice, maxPrice, includeInactive } = req.query;

    if (includeInactive !== undefined && includeInactive !== "true" && includeInactive !== "false") {
      throw new AppError("includeInactive must be true or false", 400);
    }
    const wantsInactive = includeInactive === "true";
    // Safety net: even if the route guard were removed by mistake, customers stay blocked
    if (wantsInactive && req.user?.role !== "admin") {
      throw new AppError("You do not have permission to do this.", 403);
    }

    // Customers only ever see active products. Admins may ask for all of them.
    const filter = wantsInactive ? {} : { isActive: true };

    if (search !== undefined) {
      if (typeof search !== "string") throw new AppError("Invalid search value", 400);
      if (search.trim() !== "") {
        const pattern = new RegExp(escapeRegex(search.trim()), "i");
        filter.$or = [{ name: pattern }, { description: pattern }];
      }
    }

    if (category !== undefined) {
      if (!isValidObjectId(category)) throw new AppError("Invalid category id", 400);
      filter.category = category;
    }

    const priceFilter = {};
    if (minPrice !== undefined) {
      const min = parsePrice(minPrice);
      if (min === null) throw new AppError("minPrice must be a number of 0 or more", 400);
      priceFilter.$gte = min;
    }
    if (maxPrice !== undefined) {
      const max = parsePrice(maxPrice);
      if (max === null) throw new AppError("maxPrice must be a number of 0 or more", 400);
      priceFilter.$lte = max;
    }
    if (priceFilter.$gte !== undefined && priceFilter.$lte !== undefined) {
      if (priceFilter.$gte > priceFilter.$lte) {
        throw new AppError("minPrice cannot be greater than maxPrice", 400);
      }
    }
    if (Object.keys(priceFilter).length > 0) filter.price = priceFilter;

    // Pagination
    let page = 1;
    if (req.query.page !== undefined) {
      page = parseWholeNumber(req.query.page, 1);
      if (page === null) throw new AppError("page must be a whole number of 1 or more", 400);
    }

    let limit = DEFAULT_PAGE_SIZE;
    if (req.query.limit !== undefined) {
      limit = parseWholeNumber(req.query.limit, 1);
      if (limit === null) throw new AppError("limit must be a whole number of 1 or more", 400);
      limit = Math.min(limit, MAX_PAGE_SIZE);
    }

    const [total, products] = await Promise.all([
      Product.countDocuments(filter),
      Product.find(filter)
        .populate("category", "name")
        .sort({ createdAt: -1, _id: -1 }) // newest first
        .skip((page - 1) * limit)
        .limit(limit),
    ]);

    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      success: true,
      products,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
      },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/products/:id (public)
const getProductById = async (req, res, next) => {
  try {
    checkId(req.params.id);

    const product = await Product.findOne({ _id: req.params.id, isActive: true }).populate(
      "category",
      "name"
    );
    if (!product) {
      throw new AppError("Product not found", 404);
    }

    res.status(200).json({ success: true, product });
  } catch (error) {
    next(error);
  }
};

// POST /api/products (admin)
const createProduct = async (req, res, next) => {
  try {
    const errors = validateProductFields(req.body, true);
    if (errors.length > 0) {
      throw new AppError(errors.join(". "), 400);
    }

    await ensureCategoryExists(req.body.category);

    const { name, description, price, stock, imageUrl, isActive, category } = req.body;
    const product = await Product.create({
      name,
      description,
      price,
      stock,
      imageUrl,
      isActive,
      category,
    });
    await product.populate("category", "name");

    res.status(201).json({
      success: true,
      message: "Product created successfully",
      product,
    });
  } catch (error) {
    next(error);
  }
};

// PUT /api/products/:id (admin). Only the fields you send are changed.
const updateProduct = async (req, res, next) => {
  try {
    checkId(req.params.id);

    const errors = validateProductFields(req.body, false);
    if (errors.length > 0) {
      throw new AppError(errors.join(". "), 400);
    }

    // Admins can find inactive products too, so they can switch them back on
    const product = await Product.findById(req.params.id);
    if (!product) {
      throw new AppError("Product not found", 404);
    }

    if (req.body.category !== undefined) {
      await ensureCategoryExists(req.body.category);
    }

    const editableFields = ["name", "description", "price", "stock", "imageUrl", "category", "isActive"];
    editableFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        product[field] = req.body[field];
      }
    });

    await product.save();
    await product.populate("category", "name");

    res.status(200).json({
      success: true,
      message: "Product updated successfully",
      product,
    });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/products/:id (admin). Soft delete: the product is hidden, not removed.
const deleteProduct = async (req, res, next) => {
  try {
    checkId(req.params.id);

    const product = await Product.findById(req.params.id);
    if (!product) {
      throw new AppError("Product not found", 404);
    }

    if (!product.isActive) {
      return res.status(200).json({
        success: true,
        message: "Product was already removed from the store",
      });
    }

    product.isActive = false;
    await product.save();

    res.status(200).json({
      success: true,
      message: "Product removed from the store (set to inactive)",
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
};
