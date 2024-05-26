// src/components/Layout.js
import React from "react";
import { Link } from "react-router-dom";

const Layout = ({ children, isAuthenticated, handleLogout }) => {
  return (
    <div>
      <header>
        <nav>
          <Link to="/">Home</Link>
          {isAuthenticated && (
            <>
              <button onClick={handleLogout}>Logout</button>
            </>
          )}
        </nav>
      </header>
      <main>{children}</main>
      <footer>
        <p>Footer Content</p>
      </footer>
    </div>
  );
};

export default Layout;
