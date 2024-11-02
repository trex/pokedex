import { useLoaderData, NavLink, Outlet, redirect } from "react-router-dom";
import { useState } from "react";
import { getPokedex } from "../pokemon";

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

  const filteredPokedex = pokedex.filter(pokemon => 
    pokemon.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    pokemon.id.toString().includes(searchTerm)
  );

  return (
    <>
      <div id="sidebar">
        <h1>My Pokemon</h1>
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
                    <NavLink to={`/pokemon/${pokemon.id}`}>
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
      <div id="detail">
        <Outlet />
      </div>
    </>
  );
}
  