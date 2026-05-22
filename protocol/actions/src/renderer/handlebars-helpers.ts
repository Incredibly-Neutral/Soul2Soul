// Utility function to log objects containing posts in a manageable way
function logObjectWithPosts(label: string, data: any) {
  if (Array.isArray(data)) {
    const truncatedPosts = data.map((p) => ({
      title: p?.title,
      creation_date: p?.creation_date,
      stream_id: p?.stream_id?.slice(0, 20) + "...",
    }));
    console.log(label, truncatedPosts);
  } else if (
    data &&
    typeof data === "object" &&
    data.posts &&
    Array.isArray(data.posts)
  ) {
    const truncatedData = {
      ...data,
      posts: data.posts.map((p) => ({
        title: p?.title,
        creation_date: p?.creation_date,
        stream_id: p?.stream_id?.slice(0, 20) + "...",
      })),
    };
    console.log(label, truncatedData);
  } else {
    console.log(label, data);
  }
}

export const helpers = [
  {
    name: "unique_years",
    helper: function (posts) {
      if (!posts || !Array.isArray(posts)) {
        return [];
      }

      try {
        // Extract years from creation_date fields
        const years: string[] = [];

        for (let i = 0; i < posts.length; i++) {
          const post = posts[i];
          if (!post || !post.creation_date) continue;

          try {
            // Try to handle Unix timestamp
            const dateStr = post.creation_date;
            let year: string | null = null;

            if (/^\d+$/.test(dateStr)) {
              // It's a Unix timestamp - convert to year
              const date = new Date(parseInt(dateStr) * 1000);
              year = date.getFullYear().toString();
            } else {
              // Extract year using regex
              const match = dateStr.match(/\b(19|20)\d{2}\b/);
              if (match) {
                year = match[0];
              } else if (dateStr.length >= 4 && /^\d{4}/.test(dateStr)) {
                year = dateStr.substring(0, 4);
              }
            }

            if (year && !years.includes(year)) {
              years.push(year);
            }
          } catch (e) {
            console.error("Error processing post date:", e);
          }
        }

        // Sort years in descending order
        years.sort((a, b) => parseInt(b) - parseInt(a));

        return years;
      } catch (error) {
        console.error("Error in unique_years helper:", error);
        return [];
      }
    },
  },
  {
    name: "filter_by_year",
    helper: function (year, posts) {
      if (!posts || !Array.isArray(posts) || !year) {
        return [];
      }

      try {
        // Filter posts by the given year
        const filtered: any[] = [];

        for (let i = 0; i < posts.length; i++) {
          const post = posts[i];
          if (!post || !post.creation_date) continue;

          try {
            const dateStr = post.creation_date;
            let matches = false;
            let timestamp = 0;

            // Check if it's a Unix timestamp
            if (/^\d+$/.test(dateStr)) {
              timestamp = parseInt(dateStr);
              const date = new Date(timestamp * 1000);
              const postYear = date.getFullYear().toString();
              if (postYear === year) {
                matches = true;
              }
            } else {
              // Try to extract year from date string
              const yearMatch = dateStr.match(/\b(19|20)\d{2}\b/);
              if (yearMatch && yearMatch[0] === year) {
                matches = true;
                // Try to convert to timestamp if it's an ISO date
                const date = new Date(dateStr);
                if (!isNaN(date.getTime())) {
                  timestamp = Math.floor(date.getTime() / 1000);
                }
              } else if (
                dateStr.length >= 4 &&
                dateStr.substring(0, 4) === year
              ) {
                matches = true;
              }
            }

            // If we match the year, add the post to filtered list
            if (matches) {
              filtered.push({
                ...post,
                _timestamp: timestamp,
              });
            }
          } catch (e) {
            // Silently continue if there's an error processing a post
          }
        }

        // Simple sort by creation_date in descending order (newest first)
        filtered.sort((a, b) => {
          const dateA =
            a._timestamp || (a.creation_date ? parseInt(a.creation_date) : 0);
          const dateB =
            b._timestamp || (b.creation_date ? parseInt(b.creation_date) : 0);
          return dateB - dateA; // Descending order
        });

        return filtered;
      } catch (error) {
        // Log error but continue
        console.error("Error in filter_by_year helper:", error);
        return [];
      }
    },
  },
  {
    name: "extract_images",
    helper: (input: string) => {
      if (!input) return "x";

      let arr: string[] = input.split("<").map((item) => item.trim());

      let prevWasImage = false;

      // Remove the first and last elements from the array
      arr[0] = "";
      arr.pop();

      // Process each element of the array
      arr = arr.map((item) => {
        if (item.startsWith("img") && !prevWasImage) {
          prevWasImage = true;
          return `/section><section class='container images'><${item}`;
        } else if (!item.startsWith("img") && prevWasImage) {
          prevWasImage = false;
          return `/section><section class='small-container'><${item}`;
        } else {
          return item;
        }
      });

      // Join the array back into a string
      return arr.join("<");
    },
  },
  {
    name: "markdown",
    helper: (content: string) => {
      return content;
    },
  },
  {
    name: "trim_seo_desc",
    helper: (content: string) => {
      if (content) {
        return content.length <= 140 ? content : content.substring(0, 140);
      }
    },
  },
  {
    name: "indexEqualsZero",
    helper: (index: number) => {
      return index === 0;
    },
  },
  {
    name: "moreTag",
    helper: (content: string) => {
      content = content.replace(
        "===more",
        '<a href="#" class="more_link"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 30" fill="none" x="0px" y="0px"><path fill-rule="evenodd" clip-rule="evenodd" d="M5.6159 9.67991C5.79268 9.46777 6.10797 9.4391 6.3201 9.61589L12 14.3491L17.6799 9.61589C17.8921 9.4391 18.2073 9.46777 18.3841 9.67991C18.5609 9.89204 18.5322 10.2073 18.3201 10.3841L12.3201 15.3841C12.1347 15.5386 11.8653 15.5386 11.6799 15.3841L5.67992 10.3841C5.46778 10.2073 5.43912 9.89204 5.6159 9.67991Z" fill="black"/></svg><span>Lees verder ...</span></a><div class="more">',
      );
      content = content.replace("<p></p>", "");
      content = content + "</div>";
      return content;
    },
  },
  {
    name: "relPath",
    helper: (type: string, language: string, options: any) => {
      let path = "./";
      if (language == "en") {
        path = "../";
      }
      return path;
    },
  },
  {
    name: "backgroundify",
    helper: (content: string) => {
      if (!content) return "";

      try {
        if (typeof content !== "string") {
          content = String(content);
        }

        content = content.replace(/<p>/g, "<p><span>");
        content = content.replace(/<\/p>/g, "</span></p>");

        return content;
      } catch (error) {
        console.error("Error in backgroundify helper:", error);
        return "";
      }
    },
  },
  {
    name: "ifCond",
    helper: function (v1, operator, v2, options) {
      // Make sure we have valid options
      if (!options || typeof options !== 'object') {
        return '';
      }

      let result = false;
      switch (operator) {
        case "==":
          result = v1 == v2;
          break;
        case "===":
          result = v1 === v2;
          break;
        case "!=":
          result = v1 != v2;
          break;
        case "!==":
          result = v1 !== v2;
          break;
        case "<":
          result = v1 < v2;
          break;
        case "<=":
          result = v1 <= v2;
          break;
        case ">":
          result = v1 > v2;
          break;
        case ">=":
          result = v1 >= v2;
          break;
        case "&&":
          result = !!(v1 && v2);
          break;
        case "||":
          result = !!(v1 || v2);
          break;
        default:
          result = false;
      }

      if (result) {
        return options.fn ? options.fn(this) : '';
      } else {
        return options.inverse ? options.inverse(this) : '';
      }
    },
  },
  {
    name: "isUndefined",
    helper: function(value: string, options: any) {
      if (typeof value === "undefined") {
        return options.inverse ? options.inverse(this) : "";
      } else {
        return options.fn ? options.fn(this) : "";
      }
    },
  },
  {
    name: "or",
    helper: (first: string, second: string) => {
      return first || second;
    },
  },
  {
    name: "ifIn",
    helper: function(elem: string, list: string[], options: any) {
      if (list.indexOf(elem) > -1) {
        return options.fn ? options.fn(this) : "";
      }
      return options.inverse ? options.inverse(this) : "";
    },
  },
  {
    name: "unlessIn",
    helper: function(elem: string, list: string[], options: any) {
      if (list.indexOf(elem) > -1) {
        return options.inverse ? options.inverse(this) : "";
      }
      return options.fn ? options.fn(this) : "";
    },
  },
  {
    name: "limit",
    helper: (arr: any[], limit: number) => {
      if (arr && arr.constructor === Array) {
        return arr.slice(0, limit);
      } else {
        return;
      }
    },
  },
  {
    name: "ifMoreThan",
    helper: function(a: string, b: number, options: any) {
      if (parseInt(a) > b) {
        return options.fn ? options.fn(this) : "";
      } else {
        return options.inverse ? options.inverse(this) : "";
      }
    },
  },
  {
    name: "stripHTML",
    helper: (content: string) => {
      if (content !== null && content !== undefined) {
        const strippedFromHtml = content
          .toString()
          .replace(/(&nbsp;|<([^>]+)>)/gi, "");
        return strippedFromHtml;
      } else {
        return "";
      }
    },
  },
  {
    name: "stripFromHashTags",
    helper: (content: string) => {
      if (content !== null && content !== undefined) {
        const strippedFromHashTags = content.replace(/^(\s*#\w+\s*)+$/gm, "");
        return strippedFromHashTags;
      } else {
        return "";
      }
    },
  },
  {
    name: "explode",
    helper: (array: any[]) => {
      if (array && array.length > 0) {
        const mappedArray = array.map((object) => {
          return object.slug;
        });
        return mappedArray.join(" ");
      } else {
        return "";
      }
    },
  },
  {
    name: "lowercase",
    helper: (words: string) => {
      if (words !== undefined && words !== null && typeof words !== "object") {
        return words.toLowerCase();
      } else {
        return "";
      }
    },
  },
  {
    name: "sluggify",
    helper: (words: string) => {
      if (words !== undefined && words !== null && typeof words !== "object") {
        return words
          .toLowerCase()
          .replace(/[^a-zA-Z ]/g, "")
          .trim()
          .split(" ")
          .join("-");
      } else {
        return "fout in naam";
      }
    },
  },
  {
    name: "anchorify",
    helper: (words: string) => {
      if (words !== undefined && words !== null && typeof words !== "object") {
        return words
          .toString()
          .replace(/(&nbsp;|<([^>]+)>)/gi, "")
          .toLowerCase()
          .replace(/[^a-zA-Z ]/g, "")
          .trim()
          .split(" ")
          .slice(0, 3)
          .join("-");
      } else {
        return "fout-in-anchor";
      }
    },
  },
  {
    name: "index_of",
    helper: (context: any[], index: number) => {
      return context[index];
    },
  },
  {
    name: "formatDate",
    helper: (date: string | number, language: string) => {
      try {
        let parsed;
        if (typeof date === "string") {
          // Try parsing as ISO string first
          parsed = new Date(date);
          // If invalid, try parsing as Unix timestamp
          if (isNaN(parsed.getTime())) {
            parsed = new Date(parseInt(date) * 1000);
          }
        } else {
          // Assume number is Unix timestamp
          parsed = new Date(date * 1000);
        }

        if (isNaN(parsed.getTime())) {
          console.error("formatDate: Invalid date:", date);
          return "";
        }

        let lCode = "";
        switch (language) {
          case "nl":
            lCode = "nl-NL";
            break;
          default:
            lCode = "en-US";
            break;
        }

        // Format date in Dutch style
        const formatter = new Intl.DateTimeFormat(lCode, {
          day: "numeric",
          month: "numeric",
          year: "numeric",
        });

        return formatter.format(parsed);
      } catch (error) {
        console.error("formatDate error:", error);
        return "";
      }
    },
  },
  {
    name: "formatDateAsMonthYear",
    helper: (date: string | number, language: string) => {
      try {
        let parsed;
        if (typeof date === "string") {
          // Try parsing as ISO string first
          parsed = new Date(date);
          // If invalid, try parsing as Unix timestamp
          if (isNaN(parsed.getTime())) {
            parsed = new Date(parseInt(date) * 1000);
          }
        } else {
          // Assume number is Unix timestamp
          parsed = new Date(date * 1000);
        }

        if (isNaN(parsed.getTime())) {
          console.error("formatDate: Invalid date:", date);
          return "";
        }

        let lCode = "";
        switch (language) {
          case "nl":
            lCode = "nl-NL";
            break;
          default:
            lCode = "en-US";
            break;
        }

        // Format date in Dutch style
        const formatter = new Intl.DateTimeFormat(lCode, {
          // day: 'numeric',
          month: "long",
          year: "numeric",
        });

        return formatter.format(parsed);
      } catch (error) {
        console.error("formatDate error:", error);
        return "";
      }
    },
  },
  {
    name: "log",
    helper: (data: string) => {
      return "<script>console.log(" + data + ");</script>";
      // return '<script></script>';
    },
  },
  {
    name: "json",
    helper: (context: any) => {
      return JSON.stringify(context, null, 2);
    },
  },
  {
    name: "concat",
    helper: (string1: string, string2: string) => {
      return string1 + string2;
    },
  },
  {
    name: "noObject",
    helper: (content: any) => {
      return content instanceof Object ? "" : content;
    },
  },
];
