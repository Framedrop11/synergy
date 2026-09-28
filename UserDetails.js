const mongoose = require("mongoose");

const userDetailsSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      minlength: [3, "Name must be at least 3 characters long"],
    },
    phone: {
      type: String,
      required: false,
      validate: {
        validator: function (v) {
          if (v == null || v === "") return true;
          return /^\d{10}$/.test(v);
        },
        message: (props) => `${props.value} is not a valid phone number!`,
      },
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      validate: {
        validator: function (v) {
          return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
        },
        message: (props) => `${props.value} is not a valid email address!`,
      },
    },
    password: {
      type: String,
      required: false,
      minlength: [6, "Password must be at least 6 characters long"],
    },
    googleId: {
      type: String,
      sparse: true,
      unique: true,
    },
  },
  {
    collection: "UserInfo",
  }
);

module.exports = mongoose.model("UserInfo", userDetailsSchema);
