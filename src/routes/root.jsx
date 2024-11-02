import { useLoaderData, NavLink, Outlet, redirect } from "react-router-dom";
import { useState, useEffect } from "react";
import { getPokedex } from "../pokemon";
import Settings, { measurementUnits } from "../settings";
// Get the base URL from Vite's env
const base = import.meta.env.BASE_URL;

export async function loader({ request }) {
  // Hardcoded to National Pokedex for now 
  const pokedex = await getPokedex(1);
  
  // Check if we're on the root path (basename)
  if (new URL(request.url).pathname === '/pokedex/') {
    const randomPokemon = pokedex[Math.floor(Math.random() * pokedex.length)];
    return redirect(`/pokemon/${randomPokemon.id}`);
  }
  
  return { pokedex };
}

export default function Root() {
  const { pokedex } = useLoaderData();
  const [searchTerm, setSearchTerm] = useState("");
  const [heightUnit, setHeightUnit] = useState(measurementUnits.height.find((unit) => unit.name === "feet"));
  const [weightUnit, setWeightUnit] = useState(measurementUnits.weight.find((unit) => unit.name === "pounds"));
  const [showSettings, setShowSettings] = useState(false);
  const [isSidebarOpen, setSidebarOpen] = useState(window.innerWidth > 768);

  useEffect(() => {
    const handleResize = () => {
      setSidebarOpen(window.innerWidth > 768);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const filteredPokedex = pokedex.filter(pokemon => 
    pokemon.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    pokemon.id.toString().includes(searchTerm)
  );

  return (
    <>
      <button 
        className="sidebar-toggle"
        onClick={() => setSidebarOpen(!isSidebarOpen)}
        aria-label={isSidebarOpen ? "Close sidebar" : "Open sidebar"}
      >
        {isSidebarOpen ? '←' : '→'}
      </button>

      <div id="sidebar" className={isSidebarOpen ? 'open' : 'closed'}>
        <div className="header-container">
          <img 
            src={`${base}/poke-ball.png`}
            alt="Pokeball"
            className="header-icon"
          />
          <h1 className="pokemon-title">My Pokedex</h1>
          <button 
            className="settings-button"
            onClick={() => setShowSettings(!showSettings)}
            aria-label="Settings"
          >
            ⚙️
          </button>
        </div>
        
        {showSettings && (
          <Settings 
            measurementUnits={measurementUnits}
            heightUnit={heightUnit}
            weightUnit={weightUnit}
            setHeightUnit={setHeightUnit}
            setWeightUnit={setWeightUnit}
          />
        )}

        <div className="search-container">
          <input
            type="text"
            placeholder="Search Pokemon..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="search-input"
          />
        </div>
        <div className="nav-container">
          <nav>
            {filteredPokedex.length ? (
              <ul>
                {filteredPokedex.map((pokemon) => (
                  <li key={pokemon.id}>
                    <NavLink 
                      to={`/pokemon/${pokemon.id}`}
                      onClick={() => {
                        if (window.innerWidth <= 768) {
                          setSidebarOpen(false);
                        }
                      }}
                    >
                      <span className="pokemon-id">{pokemon.id}</span>
                      <span className="pokemon-name">{pokemon.name}</span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            ) : (
              <p><i>No Pokemon found</i></p>
            )}
          </nav>
        </div>
      </div>
      <div id="detail" className={isSidebarOpen ? 'sidebar-open' : 'sidebar-closed'}>
        <Outlet context={{ heightUnit, weightUnit }} />
      </div>
    </>
  );
}
  