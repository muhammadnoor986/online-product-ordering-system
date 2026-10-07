import { Routes, Route } from "react-router-dom";
import HealthPage from "./pages/HealthPage.jsx";

function App() {
  return (
    <Routes>
      <Route path="/" element={<HealthPage />} />
    </Routes>
  );
}

export default App;
