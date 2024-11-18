import { useLoaderData, NavLink, Outlet, redirect } from "react-router-dom";
import { useState, useEffect, useMemo } from "react";
import { getPokedex } from "../pokemon";
import Settings, { measurementUnits } from "../settings";
import NavButton from "../nav-button";
// Get the base URL from Vite's env
const base = import.meta.env.BASE_URL;

export async function loader({ request }) {
  // Hardcoded to National Pokedex for now 
  const pokedex = await getPokedex(1);
  
  // Check if we're on the root path (basename)
  if (new URL(request.url).pathname === '/pokedex/') {
    const randomPokemon = pokedex.pokemon[Math.floor(Math.random() * pokedex.pokemon.length)];
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
  const [isNavOpen, setNavOpen] = useState(window.innerWidth > 768);
  const [sortColumn, setSortColumn] = useState("id");
  const [sortOrder, setSortOrder] = useState("asc");

  useEffect(() => {
    const handleResize = () => {
      setNavOpen(window.innerWidth > 768);
    };

    // Add touch event handlers to prevent accidental nav closing
    const handleTouchStart = (e) => {
      if (window.innerWidth <= 768 && e.target.closest('#nav-container')) {
        e.stopPropagation();
      }
    };

    window.addEventListener('resize', handleResize);
    document.addEventListener('touchstart', handleTouchStart, { passive: false });

    return () => {
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('touchstart', handleTouchStart);
    };
  }, []);

  const filteredPokedex = useMemo(() => {
    if (searchTerm.length === 0) {
      return pokedex.pokemon;
    }
    return pokedex.pokemon.filter((pokemon) => {
      const search = searchTerm.toLowerCase();
      return pokemon.name.includes(search) ||
      String(pokemon.id).includes(search) || 
      String(pokemon.weight).includes(search)
    });
  }, [searchTerm, pokedex]);

  const sortedPokedex = useMemo(() => {
    console.log("updating sortedPokedex", sortColumn, sortOrder);
    return filteredPokedex.toSorted((a, b) => {
      const aValue = a[sortColumn];
      const bValue = b[sortColumn];
      if (sortOrder === "asc") { 
        return aValue < bValue ? -1 : 1;
      } else {
        return aValue > bValue ? -1 : 1;
      }
    });
  }, [filteredPokedex, sortOrder, sortColumn]);

  const handleHeaderClick = (column) => {
    if (column === sortColumn) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(column);
      setSortOrder("asc");
    }
  };


  return (
    <>
      <div className="col-4">
        <div className="header-container row">
          <div className="row">
            <img 
              src={`${base}/poke-ball.png`}
              alt="Pokeball"
              className="header-icon"
            />
            <h1 className="pokemon-title">{pokedex.name} Pokedex</h1>
          </div>
          <NavButton open={isNavOpen} setOpen={setNavOpen} />
        </div>
        <div id="nav-container"className={`${isNavOpen ? 'nav-open' : 'nav-closed'}`}>
          <div className="row search-row">
            <div className="search-container">
              <input
                type="text"
                placeholder="Search Pokemon..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="search-input"
              />
            </div>
            <button 
              className="settings-button"
              onClick={() => setShowSettings(!showSettings)}
              aria-label="Settings"
            >
              ⚙️
            </button>
          </div>
          <div className="row settings-container">
            {showSettings && (
              <Settings 
                measurementUnits={measurementUnits}
                heightUnit={heightUnit}
                weightUnit={weightUnit}
                setHeightUnit={setHeightUnit}
                setWeightUnit={setWeightUnit}
              />
            )}
          </div>
          <nav>
            <table>
              <thead>
                  <tr>
                    <th>
                      <button
                        className="link"
                        onClick={() => handleHeaderClick("name")}
                        aria-label="Name"
                      >
                        Name {sortColumn === "name" && (sortOrder === "asc" ? "↑" : "↓")}
                      </button>
                    </th>
                    <th>
                      <button
                        className="link"
                        onClick={() => handleHeaderClick("id")}
                        aria-label="ID"
                      >
                        ID {sortColumn === "id" && (sortOrder === "asc" ? "↑" : "↓")}
                      </button>
                    </th>
                  </tr>
                </thead>
              {sortedPokedex.length ? (
                <tbody>
                  {sortedPokedex.map((pokemon) => (
                    <tr key={pokemon.id}>
                      <NavLink 
                        to={`/pokemon/${pokemon.id}`}
                        onClick={() => {
                          if (window.innerWidth <= 768) {
                            setNavOpen(false);
                          }
                        }}
                      >
                        <td className="left-group">
                          <img className="pokemon-front-default-sprite" src={`${base}/pokemon_sprites/front_default/${pokemon.id}.png`} alt={pokemon.name} />
                          <span className="pokemon-name">{pokemon.name}</span>
                        </td>
                        <td className="pokemon-id">{pokemon.id}</td>
                      </NavLink>
                    </tr>
                  ))}
                </tbody>
              ) : (
                <p><i>No Pokemon found</i></p>
              )}
            </table>
          </nav>
        </div>
      </div>
    
      <div id="detail" className={`col-6 ${isNavOpen ? 'nav-open' : 'nav-closed'}`}>
        <div className="row">
          <Outlet context={{ heightUnit, weightUnit }} />
        </div>
      </div>
    </>
  );
}