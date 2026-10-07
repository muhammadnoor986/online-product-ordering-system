// Turns an Axios error into a short message that is safe to show to users.
// (We never show the raw error object.)
const getErrorMessage = (error, fallbackMessage) => {
  if (error.response) {
    // The API answered with an error. Its message is already written for people.
    return error.response.data?.message || fallbackMessage;
  }
  // No answer at all: server is down, or no internet
  return "Cannot reach the server. Please check your connection and try again.";
};

export default getErrorMessage;
