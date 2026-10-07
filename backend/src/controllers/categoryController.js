const Category = require("../models/Category");
const Product = require("../models/Product");
const AppError = require("../utils/AppError");
const isValidObjectId = require("../utils/isValidObjectId");

// Case-insensitive comparison, so "Shoes" and "shoes" count as the same name
const NAME_COLLATION = { locale: "en", strength: 2 };

// Returns an array of problems (empty array = input is valid)
const validateCategory = ({ name, description } = {}) => {
  const errors = [];
  if (typeof name !== "string" || !name.trim()) errors.push("Category name is required");
  if (description !== undefined && typeof description !== "string") {
    errors.push("Description must be text");
  }
  return errors;
};

const checkId = (id) => {
  if (!isValidObjectId(id)) {
    throw new AppError("Invalid category id", 400);
  }
};

// GET /api/categories (public)
const getCategories = async (req, res, next) => {
  try {
    const categories = await Category.find().sort({ name: 1 }).collation({ locale: "en" });

    res.status(200).json({ success: true, count: categories.length, categories });
  } catch (error) {
    next(error);
  }
};

// POST /api/categories (admin)
const createCategory = async (req, res, next) => {
  try {
    const errors = validateCategory(req.body);
    if (errors.length > 0) {
      throw new AppError(errors.join(". "), 400);
    }

    const name = req.body.name.trim();

    const existing = await Category.findOne({ name }).collation(NAME_COLLATION);
    if (existing) {
      throw new AppError("A category with this name already exists", 409);
    }

    const category = await Category.create({ name, description: req.body.description });

    res.status(201).json({
      success: true,
      message: "Category created successfully",
      category,
    });
  } catch (error) {
    next(error);
  }
};

// PUT /api/categories/:id (admin)
const updateCategory = async (req, res, next) => {
  try {
    checkId(req.params.id);

    const errors = validateCategory(req.body);
    if (errors.length > 0) {
      throw new AppError(errors.join(". "), 400);
    }

    const category = await Category.findById(req.params.id);
    if (!category) {
      throw new AppError("Category not found", 404);
    }

    const name = req.body.name.trim();

    // Another category (not this one) must not already use the name
    const duplicate = await Category.findOne({ name, _id: { $ne: category._id } }).collation(
      NAME_COLLATION
    );
    if (duplicate) {
      throw new AppError("A category with this name already exists", 409);
    }

    category.name = name;
    if (req.body.description !== undefined) {
      category.description = req.body.description;
    }
    await category.save();

    res.status(200).json({
      success: true,
      message: "Category updated successfully",
      category,
    });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/categories/:id (admin)
const deleteCategory = async (req, res, next) => {
  try {
    checkId(req.params.id);

    const category = await Category.findById(req.params.id);
    if (!category) {
      throw new AppError("Category not found", 404);
    }

    // Counts hidden (inactive) products too, because they still point to this category
    const productCount = await Product.countDocuments({ category: category._id });
    if (productCount > 0) {
      throw new AppError(
        `Cannot delete this category because ${productCount} product(s) still use it. ` +
          "Move or remove those products first.",
        409
      );
    }

    await category.deleteOne();

    res.status(200).json({ success: true, message: "Category deleted successfully" });
  } catch (error) {
    next(error);
  }
};

module.exports = { getCategories, createCategory, updateCategory, deleteCategory };
