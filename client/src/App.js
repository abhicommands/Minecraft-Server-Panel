import React from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Home from "./components/Home";
import ServerDetails from "./components/ServerDetails";
import CreateServer from "./components/CreateServer";
function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/server/:id/*" element={<ServerDetails />} />
        <Route path="/create-server" element={<CreateServer />} />
        <Route path="*" element={<h1>Page Doesn't exist</h1>} />
      </Routes>
    </Router>
  );
}

export default App;
