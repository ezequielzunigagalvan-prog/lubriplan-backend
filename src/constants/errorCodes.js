// src/constants/errorCodes.js

export const ERROR_CODES = {
  PLANT_REQUIRED: "PLANT_REQUIRED",
  INVALID_ID: "INVALID_ID",
  NOT_FOUND: "NOT_FOUND",
  INVALID_TRANSITION: "INVALID_TRANSITION",
  DUPLICATE_ENTRY: "DUPLICATE_ENTRY",
  INVALID_INPUT: "INVALID_INPUT",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  INTERNAL_ERROR: "INTERNAL_ERROR",
};

export const ERROR_MESSAGES = {
  PLANT_REQUIRED: "Plant ID is required",
  INVALID_ID: "Invalid ID provided",
  NOT_FOUND: "Resource not found",
  INVALID_TRANSITION: "Invalid state transition",
  DUPLICATE_ENTRY: "Resource already exists",
  INVALID_INPUT: "Invalid input provided",
  UNAUTHORIZED: "Unauthorized access",
  FORBIDDEN: "Access forbidden",
  INTERNAL_ERROR: "Internal server error",
};

export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
};
