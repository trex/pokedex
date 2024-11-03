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
        <div 
            className="pokemon-card" 
            style={{ "--pokemon-color": pokemon.color.name }} 
            data-type={primaryType}
        >
            <div className="card-header">
                <div className="card-header-left">
                    <img src="../stage-2.png" alt="basic" className="stage-icon" />
                    <h1 className="pokemon-name">{pokemon.name}</h1>
                </div>
                <div className="card-header-right">
                    <div className="pokemon-hp">
                        <span className="hp-label">HP</span><span className="hp-value">{pokemon.stats.find((stat) => stat.stat.name === "hp").base_stat}</span>
                    </div>
                    <div className="types">
                        {pokemon.types.map((type) => (
                            <img 
                                key={type.type.name} 
                                src={`../type-icons/${type.type.name}.png`} 
                                className="type-badge"
                                alt={`${type.type.name} type`} 
                            />
                        ))}
                    </div>
                </div>
            </div>
            
            <div className="card-body">
                <div className="pokemon-image-container" data-type={primaryType}>
                    <img src={pokemon.sprites.other["official-artwork"].front_default} alt={pokemon.name} className="pokemon-image" />
                    <div className="info-row">
                        <span className="pokemon-number">No. {pokemon.id}</span>
                        <span className="genus">{pokemon.genera.find((genus) => genus.language.name === "en").genus}</span>
                        <span>Height: {heightUnit.conversion(pokemon.height)} {heightUnit.abreviation}</span>
                        <span>Weight: {weightUnit.conversion(pokemon.weight)} {weightUnit.abreviation}</span> 
                    </div>
                </div>
                
                <div className="pokemon-info">
                    <div className="pokemon-description">
                        {pokemon.flavor_text_entries.find((entry) => entry.language.name === "en").flavor_text}
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