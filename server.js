require("dotenv").config()
const express = require("express")
const bcrypt = require("bcrypt")
const jwt = require("jsonwebtoken");
const { XMLParser } = require("fast-xml-parser")



const http = require("http");
const { neon } = require("@neondatabase/serverless");
const e = require("express");

const app = express();
app.use(express.json());

const sql = neon(process.env.DATABASE_URL);

app.post("/register", async (req, res) => {
  if (!req.body) {
    return res.status(400).json({ error: "No data was detected" })
  }
  const { username, password } = req.body
  const ValidationResult = validateUserInfo(username, password)
  if (ValidationResult.valid != true) {
    return res.status(400).json({ error: ValidationResult.message })
  }

  const saltRounds = 10;
  const hash = await bcrypt.hash(password, saltRounds);
  let id
  try {
    id = await sql`INSERT INTO public."Users" (username, password_hash, num_of_plays, profile_image) VALUES (${username},${hash}, 0, NULL) RETURNING id`

  } catch (error) {
    return res.status(500).json({ error: error, errorMessage: "failed to add new User" })
  }

  const payload = { id: id[0].id }
  const token = createJWT(payload, 7)
  return res.status(201).json({ token: token })
})

app.post("/login", async (req, res) => {
  if (!req.body) {
    return res.status(400).json({ error: "No Data Was Detected" })
  }
  const { username, password } = req.body
  const validationResult = validateUserInfo(username, password)

  if (!validationResult.valid) {
    return res.status(400).json({ error: validationResult.message })
  }

  let user
  try {
    user = await sql`
      SELECT id, username, password_hash
      FROM public."Users"
      WHERE username = ${username}
      LIMIT 1;
    `
  } catch (error) {
    console.error("DB error:", error)
    return res.status(500).json({ error: "Internal server error" })
  }

  if (!user || user.length === 0) {
    return res.status(400).json({ message: "Invalid username or password" })
  }

  const hashedPassword = user[0].password_hash

  let isMatch
  try {
    isMatch = await bcrypt.compare(password, hashedPassword)
  } catch (err) {
    console.error("Bcrypt error:", err)
    return res.status(500).json({ error: "Internal server error" })
  }

  if (!isMatch) {
    return res.status(400).json({ message: "Invalid username or password" })
  }

  const payload = { id: user[0].id }
  const token = createJWT(payload, 7)

  return res.status(200).json({
    message: "Login successful",
    token: token
  })
})

app.post("/add_boardgame", authMiddleware, async (req, res) => {
  if (!req.body || !req.body.boardgameId) {
    return res.status(400).json({ error: "No data was detected!" })
  }
  const { boardgameId } = req.body
  if (isNaN(boardgameId)) {
    return res.status(400).json({ error: "Invalid boardgame id!" })
  }

  let boardgameName;
  let imageURL, yearPublished, description

  try {

    const result = await getInfoFromBGG(boardgameId);
    if (result.error) {
      return res.status(400).json({ error: result.error })
    }

    boardgameName = result.name
    description = result.description
    imageURL = result.image
    yearPublished = result.yearPublished

    if (!boardgameName) {
      return res.status(400).json({ error: "Boardgame has no name!" });
    }

  } catch (error) {
    return res.status(500).json({ error: "Failed to get info from BGG" })
  }
  try {
    const exists = await sql`SELECT 1 FROM public."boardgames" WHERE bgg_id = ${boardgameId} LIMIT 1;`
    if (exists.length > 0) {
      return res.status(409).json({ error: "Boardgame already exists!" })
    }

    await sql`INSERT INTO public."boardgames" ( title, bgg_id, description, year_published, image) VALUES (${boardgameName},${boardgameId},${description},${yearPublished},${imageURL});`
  } catch (error) {
    console.log(error)
    return res.status(500).json({ error: "Failed to add new boardgame" })
  }
  return res.status(201).json({ message: "New Boardgame added succussfully", bggId: boardgameId })

})

app.post("/add_play", authMiddleware, (async (req, res) => {
  if (!req.body || !req.body.boardgameId || !req.body.date || !req.body.duration) {
    return res.status(400).json({ error: "No data was detected!" })
  }

  const userId = Number(req.user.id)
  if (!Number.isInteger(userId || userId <= 0)) {
    return res.status(400).json({ error: "Invalid user ID extracted from token." })
  }

  const { boardgameId, date, duration, description } = req.body;
  const durationRegex = /^\s*(?:(\d+)\s*hours?)?\s*(?:(\d+)\s*minutes?)?\s*$/i

  const dateRegex = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

  if (isNaN(Number(boardgameId))) {
    return res.status(400).json({ error: "boardgameId must be a number" })
  }

  if (!dateRegex.test(date)) {
    return res.status(400).json({ error: "Invalid Date format! acceptable format: XXXX-XX-XX" })
  }

  if (!durationRegex.test(duration)) {
    return res.status(400).json({ error: "Invalid duration format! acceptable format: X hours and X minutes" })
  }

  let playId;
  try {
    const boardgameOfPlay = await findBoardgameById(boardgameId)
    if (boardgameOfPlay.bgg_id) {
      playId = await sql`INSERT INTO "Plays" (date_played, duration, description, boardgame_id, created_by) VALUES (${date},${duration},${description},${boardgameId}, ${userId}) RETURNING id`
    } else {
      return res.status(400).json(boardgameOfPlay)
    }
  } catch (error) {
    console.log(error)
    return res.status(500).json({ error: "Internal server error! Falied to add new play" })
  }

  return res.status(201).json({ message: "New play added successfully", playId: playId[0].id })


}))

app.post("/add_play_participant", authMiddleware, async (req, res) => {
  if (!req.body || !req.body.playId || typeof req.body.isWinner === "undefined" || typeof req.body.isGuest === "undefined" || (!req.body.guestName && !req.body.userId)) {
    return res.status(400).json({ error: "No data was detected!" })
  }
  const { playId, isWinner, guestName, userId, isGuest } = req.body

  if (isNaN(playId)) {
    return res.status(400).json({ error: "Id must be a number!" })
  }

  if (typeof isGuest !== "boolean") {
    return res.status(400).json({ error: "Is guest must be true or false!" })
  }

  if (typeof isWinner !== "boolean") { return res.status(400).json({ error: "Is winner must be True or False!" }) }

  if (isGuest) {
    if (typeof guestName !== "string" || guestName.trim().length < 3) {
      return res.status(400).json({ error: "Guest name must be a string and have at least 3 characters!" })
    }
  }

  if (!isGuest && (isNaN(Number(userId)) || Number(userId) <= 0)) {
    return res.status(400).json({ error: "User id must be a valid number!" })
  }

  try {
    const play = await findPlayById(playId)
    if (!play.boardgame_id) {
      return res.status(400).json(play)
    }
  } catch (error) {
    return res.status(500).json({ error: "internal server error!" })
  }

  try {
    if (isGuest) {
      const playParticipantId = await sql`INSERT INTO "playParticipants" (play_id, user_id, guest_name, is_winner, is_guest) VALUES (${playId},NULL, ${guestName}, ${isWinner}, ${isGuest}) RETURNING id;`
      return res.status(201).json({ message: "New participant added successfully!", playParticipantId: playParticipantId[0].id })
    }

    const user = await findUserById(userId)
    if (!user.username) {
      return res.status(400).json(user)
    }
    await sql`BEGIN`

    const playParticipantId = await sql`
    INSERT INTO "playParticipants" (play_id, user_id, guest_name, is_winner, is_guest)
    VALUES (${playId}, ${userId}, NULL, ${isWinner}, ${isGuest})
    RETURNING id;
  `;

    await sql`
    UPDATE "Users"
    SET num_of_plays = num_of_plays + 1
    WHERE id = ${userId};
  `;

    await sql`COMMIT`;

    return res.status(201).json({ message: "New participant added successfully!", playParticipantId: playParticipantId[0].id })


  } catch (error) {
    console.error(error)
    return res.status(500).json({ error: "internal server error! Falied to add new participant" })
  }

})

app.get("/dashboard", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  let user
  let numberOfWins
  try {
    user = await findUserById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    numberOfWins = await sql`SELECT COUNT(*) FROM "playParticipants" WHERE user_id = ${userId} AND is_winner = true`
  } catch (error) {
    return res.status(500).json({ error: "Internal server error!" })
  }
  return res.status(200).json({ user: user, numberOfWins: numberOfWins[0].count })
})

app.get("/dashboard/:id", authMiddleware, async (req, res) => {
  const userId = Number(req.params.id)

  if (isNaN(userId) || userId <= 0) {
    return res.status(400).json({ error: "Id must be a number and bigger than 0!" })
  }

  let user
  let numberOfWins

  try {
    user = await findUserById(userId)

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    numberOfWins = await sql`SELECT COUNT(*) FROM "playParticipants" WHERE user_id = ${userId} AND is_winner = true`

  } catch (error) {

    console.error("Dashboard Error:", error);
    return res.status(500).json({ error: "Internal server error!" })

  }

  return res.status(200).json({ user, numberOfWins: numberOfWins[0].count })
})

app.get("/me/stats", authMiddleware, async (req, res) => {
  const userId = req.user.id

  if (!userId || isNaN(userId)) {
    return res.status(400).json({ error: "Invalid User ID" });
  }

  let stats;

  try {
    stats = await sql`SELECT 
    u.id AS user_id,
    u.username,

    COUNT(CASE WHEN pp.is_winner = true THEN 1 END) AS total_wins,

    (
        SELECT COALESCE(u2.username, pp2.guest_name)
        FROM "playParticipants" pp2
        LEFT JOIN "Users" u2 ON pp2.user_id = u2.id
        WHERE pp2.play_id IN (
            SELECT p.id
            FROM "Plays" p
            JOIN "playParticipants" sub_pp ON p.id = sub_pp.play_id
            WHERE sub_pp.user_id = u.id AND sub_pp.is_winner = true
        )
        AND (pp2.user_id != u.id OR pp2.user_id IS NULL)
        AND pp2.is_winner = false
        GROUP BY COALESCE(u2.username, pp2.guest_name)
        ORDER BY COUNT(*) DESC
        LIMIT 1
    ) AS most_defeated_player,

    (
        SELECT b.title
        FROM boardgames b
        JOIN "Plays" p3 ON b.bgg_id = p3.boardgame_id
        JOIN "playParticipants" pp3 ON p3.id = pp3.play_id
        WHERE pp3.user_id = u.id AND pp3.is_winner = true
        GROUP BY b.title
        ORDER BY COUNT(*) DESC
        LIMIT 1
    ) AS most_won_game,

    (
        SELECT b.title
        FROM boardgames b
        JOIN "Plays" p4 ON b.bgg_id = p4.boardgame_id
        JOIN "playParticipants" pp4 ON p4.id = pp4.play_id
        WHERE pp4.user_id = u.id AND pp4.is_winner = false
        GROUP BY b.title
        ORDER BY COUNT(*) DESC
        LIMIT 1
    ) AS most_lost_game,

    (
        SELECT COALESCE(u3.username, pp5.guest_name)
        FROM "playParticipants" pp5
        LEFT JOIN "Users" u3 ON pp5.user_id = u3.id
        WHERE pp5.play_id IN (
            SELECT p.id
            FROM "Plays" p
            JOIN "playParticipants" sub_pp ON p.id = sub_pp.play_id
            WHERE sub_pp.user_id = u.id AND sub_pp.is_winner = false
        )
        AND (pp5.user_id != u.id OR pp5.user_id IS NULL)
        AND pp5.is_winner = true
        GROUP BY COALESCE(u3.username, pp5.guest_name)
        ORDER BY COUNT(*) DESC
        LIMIT 1
    ) AS most_winning_opponent,

    COUNT(DISTINCT p.boardgame_id) AS total_unique_games_played,

    (
        SELECT b.title
        FROM boardgames b
        JOIN "Plays" p6 ON b.bgg_id = p6.boardgame_id
        JOIN "playParticipants" pp6 ON p6.id = pp6.play_id
        WHERE pp6.user_id = u.id
        GROUP BY b.title
        ORDER BY COUNT(*) DESC
        LIMIT 1
    ) AS most_played_game,

    SUM(p.duration) AS total_play_time

FROM 
    "Users" u
LEFT JOIN "playParticipants" pp ON u.id = pp.user_id
LEFT JOIN "Plays" p ON pp.play_id = p.id
WHERE 
    u.id = ${userId}
GROUP BY 
    u.id, u.username;
`
  } catch (error) {
    return res.status(500).json({ error: "Falied to get Stats from database" })
  }

  if (!stats || stats.length === 0) {
    return res.status(404).json({ error: "No stats found for user" });
  }

  return res.status(200).json(stats[0])
})

app.get("/get_user/:id", authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (isNaN(id)) {
    return res.status(400).json({ error: "Invalid Id! Id must be a number" })
  }

  let user;

  try {
    user = await findUserById(id)

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    return res.status(200).json({ user })
  } catch (error) {
    return res.status(500).json(user)
  }

})

app.get("/users", authMiddleware, async (req, res) => {
  const idsQuery = req.query.ids
  if (!idsQuery) {
    return res.status(400).json({ error: "No Ids provided!" })
  }

  const ids = idsQuery.split(",").map((id) =>
    parseInt(id, 10)
  ).filter(id => !isNaN(id))

  if (ids.length === 0) {
    return res.status(400).json({ error: "No valid Id was provided!" })
  }

  const users = await Promise.all(ids.map(id => findUserById(id)));

  return res.status(200).json({ users: users })

})

app.get("/users/search/:username", authMiddleware, async (req, res) => {
  const username = req.params.username

  if (!username || typeof username !== "string" || username.trim().length < 3) {
    return res.status(400).json({ error: "Username must be a string with at least 3 characters." })
  }

  try {
    const users = await sql`
      SELECT * FROM "Users"
      WHERE username ILIKE ${`%${username.trim()}%`}
      LIMIT 20
    `

    if (users.length === 0) {
      return res.status(404).json({ error: "No users found with this username" })
    }

    return res.status(200).json(users)
  } catch (error) {
    console.error("GET /users/search/:username", error)
    return res.status(500).json({ error: "Internal server error" })
  }
})


app.get("/plays/:id", authMiddleware, async (req, res) => {
  const idParam = req.params.id
  if (!idParam) return res.status(400).json({ error: "Missing play ID!" })

  const playId = parseInt(idParam, 10)
  if (isNaN(playId) || playId <= 0)
    return res.status(400).json({ error: "Play ID must be a positive integer!" })

  try {
    const play = await findPlayById(playId)
    if (!play) return res.status(404).json({ error: "Play not found!" })

    return res.status(200).json(play)
  } catch (error) {
    console.error("Error fetching play:", error)
    return res.status(500).json({ error: "Internal server error." })
  }
})

app.get("/participants/:id", authMiddleware, async (req, res) => {
  const playId = Number(req.params.id)

  if (!playId) return res.status(400).json({ error: "Missing play ID!" })

  if (!Number.isInteger(playId) || playId <= 0) {
    return res.status(400).json({ error: "Play ID must be a positive integer!" })
  }

  let participants

  try {

    participants = await sql`SELECT * FROM "playParticipants" WHERE play_id = ${playId}`

    if (participants.length === 0) {
      return res.status(404).json({ error: "Could not find Play or play participants!" })
    }

    return res.status(200).json({ participants })

  } catch (error) {
    console.error(error)
    return res.status(500).json({ error: "Internal server error." })
  }

})

app.get("/me/plays", authMiddleware, async (req, res) => {
  const userId = Number(req.user.id)

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: "Invalid user ID extracted from token." })
  }

  let plays

  try {

    plays = await sql`
      SELECT p.* FROM "Plays" p
      JOIN "playParticipants" pp ON p.id = pp.play_id
      WHERE pp.user_id = ${userId}
      ORDER BY p.date_played DESC`

    if (!plays || plays.length === 0) {
      return res.status(200).json({ plays: [], message: "User has no recorded plays yet." })
    }

    return res.status(200).json(plays)
  } catch (error) {

    console.error("GET /plays error:", error)

    return res.status(500).json({ error: "Internal server error!" })
  }
})

app.patch("/plays/:id", authMiddleware, async (req, res) => {
  const playId = Number(req.params.id)

  if (!Number.isInteger(playId) || playId <= 0) {
    return res.status(400).json({ error: "Invalid Id! Id must be a positive integer!" })
  }

  let play
  try {
    play = await findPlayById(playId)

    if (!play) {
      return res.status(404).json({ error: "Play with this id does not exist!" })
    }
  } catch (error) {
    console.error(error)
    return res.status(500).json({ error: "Internal server error!" })
  }

  const { date, duration, description } = req.body
  const updates = {}

  const dateRegex = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
  const durationRegex = /^\s*(?:(\d+)\s*hours?)?\s*(?:(\d+)\s*minutes?)?\s*$/i

  if (date !== undefined) {
    if (!dateRegex.test(date)) {
      return res.status(400).json({ error: "Invalid date format! Use YYYY-MM-DD" })
    }
    updates.date_played = date
  }

  if (duration !== undefined) {
    if (!durationRegex.test(duration)) {
      return res.status(400).json({ error: "Invalid duration format! Use 'X hours X minutes'" })
    }
    updates.duration = duration
  }

  if (description !== undefined) {
    updates.description = description.trim()
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No valid fields provided for update!" })
  }

  const fields = Object.keys(updates)
    .map((key, i) => `${key} = $${i + 1}`)
    .join(", ")

  const values = Object.values(updates)

  try {
    const [updatedPlay] = await sql.unsafe(
      `UPDATE "Plays" SET ${fields} WHERE id = $${values.length + 1} RETURNING *`,
      [...values, playId]
    )

    if (!updatedPlay) {
      return res.status(500).json({ error: "Failed to update play!" })
    }

    return res.status(200).json(updatedPlay)
  } catch (error) {
    console.error("Dynamic update error:", error)
    return res.status(500).json({ error: "Internal server error!" })
  }
})

app.delete("/play/:id", authMiddleware, async (req, res) => {
  const userId = Number(req.user.id)
  const playId = Number(req.params.id)

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: "Invalid user ID extracted from token." })
  }

  if (!Number.isInteger(playId) || playId <= 0) {
    return res.status(400).json({ error: "Invalid play ID. It must be a positive integer!" })
  }

  const access = await hasAccess(userId, playId)
  if (!access.allowed) {
    const status = access.error === "Play not found" ? 404 : 403
    return res.status(status).json({ error: access.error || "Access denied." })
  }

  try {
    await sql`DELETE FROM "playParticipants" WHERE play_id = ${playId}`

    const [deletedPlay] = await sql`
      DELETE FROM "Plays" WHERE id = ${playId} RETURNING *`

    if (!deletedPlay) {
      return res.status(404).json({ error: "Play not found or already deleted." })
    }

    return res.status(200).json({
      message: "Play deleted successfully",
      deletedPlay
    })

  } catch (error) {
    console.error("DELETE /play/:id error:", error)
    return res.status(500).json({ error: "Internal server error while deleting play." })
  }
})

app.get("/boardgames", authMiddleware, async (req, res) => {
  const boardgameName = (req.query.boardgameName || "").trim()

  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100)
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1)
    const offset = (page - 1) * limit

    const boardgames = boardgameName
      ? await sql`
          SELECT * FROM public.boardgames
          WHERE title ILIKE ${'%' + boardgameName + '%'}
          LIMIT ${limit} OFFSET ${offset}
        `
      : await sql`
          SELECT * FROM public.boardgames
          LIMIT ${limit} OFFSET ${offset}
        `

    if (!boardgames || boardgames.length === 0) {
      return res.status(404).json({ error: "No games found." })
    }

    return res.status(200).json(boardgames)
  } catch (error) {
    console.error("GET /boardgames error:", error)
    return res.status(500).json({ error: "Internal server error" })
  }
});







async function hasAccess(userId, playId) {
  if (!Number.isInteger(userId) || userId <= 0) {
    return { allowed: false, error: "User Id must be a positive Integer" }
  }

  if (!Number.isInteger(playId) || playId <= 0) {
    return { allowed: false, error: "Play Id must be a positive Integer" }
  }

  let play

  try {

    play = await findPlayById(playId)

  } catch (error) {
    console.error("accessTest error:", error)
    return { allowed: false, error: "Failed to fetch play from database" }
  }

  if (!play) {
    return { allowed: false, error: "Play not found" }
  }

  if (Number(play.created_by) === userId) {
    return { allowed: true }
  } else {
    return {
      allowed: false, error: "User does not have access"
    }
  }
}


async function findPlayById(playId) {
  const playIdInt = parseInt(playId)
  if (isNaN(playIdInt)) {
    return { error: "Id must be a number" }
  }
  const play = await sql`
  SELECT date_played, duration, description, boardgame_id, created_by
  FROM "Plays" 
  WHERE id = ${playIdInt} 
  LIMIT 1
`
  if (play[0]) {
    return play[0]
  }
  return { error: "Could not find a play with the given id" }
}


async function findUserById(userId) {
  const userIdInt = parseInt(userId)
  if (isNaN(userIdInt)) {
    return { error: "Id must be a number" }
  }
  const user = await sql`
  SELECT username, num_of_plays, profile_image
  FROM "Users" 
  WHERE id = ${userIdInt} 
  LIMIT 1
`
  if (user[0]) {
    return user[0]
  }
  return { error: "Could not find a user with the given id" }
}

async function findBoardgameById(bggId) {
  const bggIdInt = parseInt(bggId)
  if (isNaN(bggIdInt)) {
    return { error: "Id must be a number" }
  }
  const boardgame = await sql`
  SELECT bgg_id, title 
  FROM "boardgames" 
  WHERE bgg_id = ${bggId} 
  LIMIT 1
`
  if (boardgame[0]) {
    return boardgame[0]
  }
  return { error: "Could not find a boardgame with the given id" }
}



async function getInfoFromBGG(gameId) {
  const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(
    `https://rpggeek.com/xmlapi2/thing?id=${gameId}`
  )}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(proxyUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept": "application/json"
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error(`HTTP Error: ${response.status} ${response.statusText}`);
      return { error: "Failed to fetch from BGG" };
    }

    const data = await response.json()
    const xml = data.contents;

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_"
    });
    const parsed = parser.parse(xml);

    const item = parsed.items?.item;
    if (!item) return { error: "Game not found" };

    const nameObj = Array.isArray(item.name)
      ? item.name.find(n => n["@_type"] === "primary")
      : item.name;
  
    return {
      id: item["@_id"] || null,
      image: item.image,
      name: nameObj?.["@_value"] || "Unknown",
      yearPublished: item.yearpublished?.["@_value"] || "N/A",
      description: item.description || "No description available"
    };

  } catch (error) {
    clearTimeout(timeoutId);
    console.error("Fetch error:", error);
    if (error.name === "AbortError") {
      return { error: "Request timed out" };
    }
    return { error: "Internal server error: " + error.message };
  }
}


function createJWT(payload, validityPeriod) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: `${validityPeriod}d` })
}

function validateUserInfo(username, password) {
  if (typeof username !== "string" || username.trim().length < 3) {
    return { valid: false, message: "Invalid username" }
  }

  if (typeof password !== "string" || password.trim().length < 3) {
    return { valid: false, message: "Invalid password" }
  }

  return { valid: true }
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization']
  if (!authHeader) return res.status(401).json({ error: "No token provided" })

  const parts = authHeader.split(' ')
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ error: "Malformed token" })
  }

  const token = parts[1]
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: "Invalid token" })

    req.user = decoded
    next()
  })
}



app.listen(3001, () => {
  console.log("Server running at http://localhost:3000")
})