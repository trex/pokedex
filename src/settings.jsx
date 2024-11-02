export const measurementUnits = {
    height: [
      {
        name: "feet",
        abreviation: "ft",
        conversion: (decimeters) => (decimeters * 0.3048).toFixed(2)
      },
      {
        name: "meters",
        abreviation: "m",
        conversion: (decimeters) => (decimeters / 10).toFixed(2)
      },
      {
        name: "inches",
        abreviation: "in",
        conversion: (decimeters) => (decimeters * 3.937).toFixed(2)
      },
      {
        name: "centimeters",
        abreviation: "cm",
        conversion: (decimeters) => decimeters.toFixed(2)
      }
    ],
    weight: [
      {
        name: "pounds",
        abreviation: "lbs",
        conversion: (hectograms) => (hectograms * 0.453592).toFixed(2)
      },
      {
        name: "kilograms",
        abreviation: "kg",
        conversion: (hectograms) => (hectograms / 10).toFixed(2)
      },
      {
        name: "ounces",
        abreviation: "oz",
        conversion: (hectograms) => (hectograms * 7.25748).toFixed(2)
      },
      {
        name: "grams",
        abreviation: "g",
        conversion: (hectograms) => (hectograms * 100).toFixed(2)
      }
    ]
  };

export default function Settings({ measurementUnits, heightUnit, weightUnit, setHeightUnit, setWeightUnit }) {
    return (
        <div className="settings-panel">
          <h2>Settings</h2>
          <div className="settings-group">
            <label>Height Units:</label>
            <select 
              value={heightUnit.name}
              onChange={(e) => {
                const selected = measurementUnits.height.find(unit => unit.name === e.target.value);
                setHeightUnit(selected);
              }}
            >
              {measurementUnits.height.map(unit => (
                <option key={unit.name} value={unit.name}>
                  {unit.name}
                </option>
              ))}
            </select>
          </div>
          <div className="settings-group">
            <label>Weight Units:</label>
            <select 
              value={weightUnit.name}
              onChange={(e) => {
                const selected = measurementUnits.weight.find(unit => unit.name === e.target.value);
                setWeightUnit(selected);
              }}
            >
              {measurementUnits.weight.map(unit => (
                <option key={unit.name} value={unit.name}>
                  {unit.name}
                </option>
              ))}
            </select>
          </div>
        </div>
    )
}