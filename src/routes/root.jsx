import { useLoaderData, NavLink, Outlet, redirect } from "react-router-dom";
import { useState } from "react";
import { getPokemons } from "../pokemons";

export async function loader({ request }) {
  const pokemons = await getPokemons();
  
  // Check if we're on the root path
  if (new URL(request.url).pathname === '/') {
    // Select a random Pokemon
    const randomPokemon = pokemons[Math.floor(Math.random() * pokemons.length)];
    // Redirect to the random Pokemon's page
    return redirect(`/pokemon/${randomPokemon.id}`);
  }
  
  return { pokemons };
}

export default function Root() {
  const { pokemons } = useLoaderData();
  const [searchTerm, setSearchTerm] = useState("");

  const filteredPokemons = pokemons.filter(pokemon => 
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
            {filteredPokemons.length ? (
              <ul>
                {filteredPokemons.map((pokemon) => (
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
  