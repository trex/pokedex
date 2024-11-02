import { useLoaderData, useOutletContext } from "react-router-dom";
import { getPokemon } from "../pokemon";

export async function loader({ params }) {
    const pokemon = await getPokemon(params.pokemonId);
    return { pokemon };
}

export default function Pokemon() {
    const { pokemon } = useLoaderData();
    const primaryType = pokemon.types[0].type.name;
    const { heightUnit, weightUnit } = useOutletContext();

    return (
        <div className="pokemon-card" data-type={primaryType}>
            <div className="card-header">
                <span className="pokemon-number">No. {pokemon.id}</span>
                <h1 className="pokemon-name">{pokemon.name}</h1>
            </div>
            
            <div className="card-body">
                <div className="pokemon-image-container" data-type={primaryType}>
                    <img src={pokemon.sprites.other["official-artwork"].front_default} alt={pokemon.name} className="pokemon-image" />
                </div>
                
                <div className="pokemon-info">
                    <div className="info-row">
                        <span className="label">Height:</span> {heightUnit.conversion(pokemon.height)} {heightUnit.abreviation}
                        <span className="label">Weight:</span> {weightUnit.conversion(pokemon.weight)} {weightUnit.abreviation}
                    </div>
                    
                    <div className="types">
                        {pokemon.types.map((type) => (
                            <span key={type.type.name} className={`type-badge ${type.type.name}`}>
                                {type.type.name}
                            </span>
                        ))}
                    </div>
                    
                    <div className="abilities">
                        <h2>Abilities</h2>
                        {pokemon.abilities.map((ability) => (
                            <span key={ability.ability.name} className="ability-badge">
                                {ability.ability.name}
                            </span>
                        ))}
                    </div>
                    
                    <div className="moves">
                        <h2>Moves</h2>
                        <div className="moves-list">
                            {pokemon.moves.slice(0, 4).map((move) => (
                                <span key={move.move.name} className="move-badge">
                                    {move.move.name}
                                </span>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}